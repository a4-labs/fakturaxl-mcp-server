import { XMLBuilder, XMLParser } from "fast-xml-parser";
import { countApiCall } from "../callContext.js";
import { config } from "../config.js";
import { logger, maskSecret, truncate } from "../logger.js";
import { AUTH_ERROR_CODES, SUCCESS_READ_CODES, describeCode } from "./codes.js";
import { rateLimiter, sleep, intervalFor } from "./rateLimiter.js";

const builder = new XMLBuilder({
  ignoreAttributes: true,
  processEntities: true,
  suppressEmptyNode: false,
});

// parseTagValue: false - NIE konwertujemy wartosci na liczby. Dla danych FakturaXL
// (NIP, telefon, nr_konta_bankowego) koercja gubi zera wiodace i zamienia dlugie
// numery na notacje naukowa (utrata danych). Wszystko zostaje stringiem.
const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
});

export class FakturaXlError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly kind: "auth" | "api" | "http" | "network" = "api",
  ) {
    super(message);
    this.name = "FakturaXlError";
  }
}

/**
 * Wartosc pola XML. Zagniezdzenia i tablice sa potrzebne dla zapisu
 * (dokument_dodaj.php wymaga sekcji <nabywca> i powtarzanych <faktura_pozycje>);
 * XMLBuilder serializuje tablice jako powtorzony tag o tej samej nazwie.
 */
export type XmlValue = string | number | undefined | null | XmlParams | XmlValue[];
export type XmlParams = { [key: string]: XmlValue };

type CleanValue = string | number | CleanParams | CleanValue[];
type CleanParams = { [key: string]: CleanValue };

/** Usuwa pola undefined/null (rekurencyjnie) - reszte serializujemy jako tagi XML. */
function cleanValue(value: XmlValue): CleanValue | undefined {
  if (value === undefined || value === null) return undefined;

  if (Array.isArray(value)) {
    const items = value.map(cleanValue).filter((v): v is CleanValue => v !== undefined);
    return items.length > 0 ? items : undefined;
  }

  if (typeof value === "object") {
    const nested = cleanParams(value);
    return Object.keys(nested).length > 0 ? nested : undefined;
  }

  return value;
}

function cleanParams(params: XmlParams): CleanParams {
  const out: CleanParams = {};
  for (const [k, v] of Object.entries(params)) {
    const cleaned = cleanValue(v);
    if (cleaned !== undefined) out[k] = cleaned;
  }
  return out;
}

/** Maskuje wartosc api_token w surowym XML na potrzeby logow. */
function maskXml(xml: string): string {
  return xml.replace(/(<api_token>)(.*?)(<\/api_token>)/gs, (_m, a, token, b) => `${a}${maskSecret(token)}${b}`);
}

function buildXml(params: CleanParams): string {
  return builder.build({ dokument: params });
}

/** Klucz kolejki limitera - limit FakturaXL obowiazuje per konto, wiec per token API. */
function scopeOf(params: XmlParams): string {
  return String(params.api_token ?? "anon");
}

/**
 * Publiczne API klienta: wywoluje endpoint FakturaXL przez rate limiter
 * (odstepy per endpoint, kolejka per token) z automatycznym retry na kod 2
 * (przekroczony limit zapytan). Agent nigdy nie musi sam obslugiwac throttlingu.
 */
export async function fakturaXlCall(endpoint: string, params: XmlParams): Promise<unknown> {
  return rateLimiter.run(scopeOf(params), endpoint, () => callWithRateLimitRetry(endpoint, params));
}

async function callWithRateLimitRetry(endpoint: string, params: XmlParams): Promise<unknown> {
  const interval = intervalFor(endpoint);
  let lastError: unknown;
  for (let attempt = 1; attempt <= config.rateLimitRetries; attempt++) {
    try {
      return await doCall(endpoint, params);
    } catch (err) {
      lastError = err;
      if (err instanceof FakturaXlError && err.code === "2") {
        const backoff = interval * attempt;
        logger.warn("fakturaxl.rate_limited_retry", { endpoint, attempt, backoffMs: backoff });
        await sleep(backoff);
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

/**
 * Pojedyncze wywolanie endpointu FakturaXL (POST XML) -> sparsowany JSON.
 * Loguje raw request/response (z zamaskowanym tokenem) zgodnie z zasadami projektu.
 */
async function doCall(endpoint: string, params: XmlParams): Promise<unknown> {
  const url = `${config.fakturaXlBaseUrl}/${endpoint}`;
  const xml = buildXml(cleanParams(params));
  const requestId = Math.random().toString(36).slice(2, 10);

  const headers = {
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
  };

  countApiCall();
  logger.info("fakturaxl.request", {
    requestId,
    method: "POST",
    url,
    headers,
    body: truncate(maskXml(xml)),
  });

  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.fakturaXlTimeoutMs);

  let responseText: string;
  let status: number;
  let responseHeaders: Record<string, string>;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: xml,
      signal: controller.signal,
    });
    status = res.status;
    responseHeaders = Object.fromEntries(res.headers.entries());
    responseText = await res.text();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("fakturaxl.network_error", { requestId, url, error: message, durationMs: Date.now() - startedAt });
    throw new FakturaXlError(`Błąd połączenia z FakturaXL: ${message}`, undefined, "network");
  } finally {
    clearTimeout(timeout);
  }

  logger.info("fakturaxl.response", {
    requestId,
    status,
    durationMs: Date.now() - startedAt,
    headers: responseHeaders,
    body: truncate(responseText),
  });

  if (status < 200 || status >= 300) {
    logger.error("fakturaxl.http_error", { requestId, url, status, body: responseText });
    throw new FakturaXlError(`FakturaXL zwróciło HTTP ${status}`, undefined, "http");
  }

  let parsed: unknown;
  try {
    parsed = parser.parse(responseText);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("fakturaxl.parse_error", { requestId, url, error: message, body: responseText });
    throw new FakturaXlError(`Nie udało się sparsować odpowiedzi XML: ${message}`, undefined, "api");
  }

  assertNoErrorCode(parsed);
  return parsed;
}

/**
 * Wykrywa kod bledu w odpowiedzi <dokument><kod>N</kod></dokument>.
 * Kody sukcesu (1,5) oraz odpowiedzi listowe (<dokumenty>) przepuszczamy.
 *
 * Walidacja zapisu zwraca WIELE tagow <kod> naraz - zweryfikowane sonda na
 * dokument_dodaj.php, ktora dla niepelnego dokumentu odpowiedziala kodami
 * 11, 13, 15 i 18. Parser daje wtedy tablice, wiec raportujemy wszystkie
 * przyczyny, a nie tylko pierwsza - agent poprawia dokument w jednym kroku.
 */
function assertNoErrorCode(parsed: unknown): void {
  const dokument = (parsed as { dokument?: { kod?: unknown; komunikat?: unknown } })?.dokument;
  const kodRaw = dokument?.kod;
  if (kodRaw === undefined || kodRaw === null) return;

  const kody = (Array.isArray(kodRaw) ? kodRaw : [kodRaw]).map(String);
  const errors = kody.filter((kod) => !SUCCESS_READ_CODES.has(kod));
  if (errors.length === 0) return;

  const opisy = errors.map((kod) => `${kod}: ${describeCode(kod) ?? "Nieznany kod odpowiedzi"}`).join("; ");
  const komunikat = dokument?.komunikat ? ` (${String(dokument.komunikat)})` : "";
  const kind = errors.some((kod) => AUTH_ERROR_CODES.has(kod)) ? "auth" : "api";
  const prefiks = errors.length > 1 ? "FakturaXL kody" : "FakturaXL kod";
  throw new FakturaXlError(`${prefiks} ${opisy}${komunikat}`, errors[0], kind);
}
