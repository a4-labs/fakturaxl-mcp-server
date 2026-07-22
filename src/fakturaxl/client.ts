import { XMLBuilder, XMLParser } from "fast-xml-parser";
import { config } from "../config.js";
import { logger, maskSecret } from "../logger.js";
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

export type XmlParams = Record<string, string | number | undefined | null>;

/** Usuwa pola undefined/null - reszte serializujemy jako tagi XML. */
function cleanParams(params: XmlParams): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    out[k] = v;
  }
  return out;
}

/** Maskuje wartosc api_token w surowym XML na potrzeby logow. */
function maskXml(xml: string): string {
  return xml.replace(/(<api_token>)(.*?)(<\/api_token>)/gs, (_m, a, token, b) => `${a}${maskSecret(token)}${b}`);
}

function buildXml(params: Record<string, string | number>): string {
  return builder.build({ dokument: params });
}

/**
 * Publiczne API klienta: wywoluje endpoint FakturaXL przez globalny rate limiter
 * (odstepy per endpoint) z automatycznym retry na kod 2 (przekroczony limit zapytan).
 * Agent nigdy nie musi sam obslugiwac throttlingu.
 */
export async function fakturaXlCall(endpoint: string, params: XmlParams): Promise<unknown> {
  return rateLimiter.run(endpoint, () => callWithRateLimitRetry(endpoint, params));
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

  logger.info("fakturaxl.request", {
    requestId,
    method: "POST",
    url,
    headers,
    body: maskXml(xml),
  });

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
    logger.error("fakturaxl.network_error", { requestId, url, error: message });
    throw new FakturaXlError(`Błąd połączenia z FakturaXL: ${message}`, undefined, "network");
  } finally {
    clearTimeout(timeout);
  }

  logger.info("fakturaxl.response", {
    requestId,
    status,
    headers: responseHeaders,
    body: responseText,
  });

  if (status < 200 || status >= 300) {
    throw new FakturaXlError(`FakturaXL zwróciło HTTP ${status}`, undefined, "http");
  }

  let parsed: unknown;
  try {
    parsed = parser.parse(responseText);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new FakturaXlError(`Nie udało się sparsować odpowiedzi XML: ${message}`, undefined, "api");
  }

  assertNoErrorCode(parsed);
  return parsed;
}

/**
 * Wykrywa kod bledu w odpowiedzi <dokument><kod>N</kod></dokument>.
 * Kody sukcesu odczytu (1,5) oraz odpowiedzi listowe (<dokumenty>) przepuszczamy.
 */
function assertNoErrorCode(parsed: unknown): void {
  const dokument = (parsed as { dokument?: { kod?: unknown; komunikat?: unknown } })?.dokument;
  const kodRaw = dokument?.kod;
  if (kodRaw === undefined || kodRaw === null) return;

  const kod = String(kodRaw);
  if (SUCCESS_READ_CODES.has(kod)) return;

  const opis = describeCode(kod) ?? "Nieznany kod odpowiedzi";
  const komunikat = dokument?.komunikat ? ` (${String(dokument.komunikat)})` : "";
  const kind = AUTH_ERROR_CODES.has(kod) ? "auth" : "api";
  throw new FakturaXlError(`FakturaXL kod ${kod}: ${opis}${komunikat}`, kod, kind);
}
