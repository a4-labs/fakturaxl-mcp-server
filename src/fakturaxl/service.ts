import { config } from "../config.js";
import { cache } from "./cache.js";
import type { Doc } from "./compact.js";
import { chunkDateRange } from "./dates.js";
import { fetchAllPages, toArray } from "./pagination.js";
import { rateLimiter, intervalFor } from "./rateLimiter.js";
import { fakturaXlCall, type XmlParams } from "./client.js";

function s(v: unknown): string {
  return v === undefined || v === null ? "" : String(v);
}

/** Normalizacja tekstu do porownan: lowercase + bez diakrytyki + trim. */
function norm(v: string): string {
  return v
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function digits(v: string): string {
  return v.replace(/\D/g, "");
}

// --- Listy slownikowe (z cache) ---

export async function getAllClients(apiToken: string): Promise<Doc[]> {
  return cache.getOrLoad(`clients:${apiToken}`, async () => {
    return (await fetchAllPages("lista_klientow.php", "klient", { api_token: apiToken })) as Doc[];
  });
}

export async function getAllProducts(apiToken: string): Promise<Doc[]> {
  return cache.getOrLoad(`products:${apiToken}`, async () => {
    return (await fetchAllPages("lista_produktow.php", "produkt", { api_token: apiToken })) as Doc[];
  });
}

export async function findClients(apiToken: string, query: string): Promise<Doc[]> {
  const clients = await getAllClients(apiToken);
  const q = norm(query);
  const qd = digits(query);
  return clients.filter((c) => {
    const byName = norm(s(c.nazwa)).includes(q) || norm(s(c.nazwa_skrocona)).includes(q);
    const byNip = qd.length >= 3 && digits(s(c.nip)).includes(qd);
    return byName || byNip;
  });
}

export async function findProducts(apiToken: string, query: string): Promise<Doc[]> {
  const products = await getAllProducts(apiToken);
  const q = norm(query);
  return products.filter(
    (p) => norm(s(p.nazwa)).includes(q) || norm(s(p.kod_produktu)).includes(q) || norm(s(p.kod_kreskowy)).includes(q),
  );
}

// --- Dokumenty ---

export type DocumentsQuery = {
  data_od: string;
  data_do: string;
  /** Data kontynuacji z poprzedniego wywolania (pole kursor_nastepny). */
  kursor?: string;
  klient?: string;
  status?: string | number;
  typ?: string | number;
  rodzaj_faktury_koszty?: string | number;
  id_dzialy_firmy?: string | number;
};

export type DocumentsProgress = {
  okien_lacznie: number;
  okien_przeszukanych_lacznie: number;
  okien_w_tym_wywolaniu: number;
  okien_pozostalo: number;
  szacowany_czas_pozostaly_s: number;
};

export type DocumentsResult = {
  docs: Doc[];
  warnings: string[];
  /** Zakres faktycznie przeszukany w TYM wywolaniu. */
  zakres_przeszukany: { data_od: string; data_do: string };
  /** Data, od ktorej nalezy kontynuowac; null gdy zakres wyczerpany. */
  kursor_nastepny: string | null;
  ukonczono: boolean;
  postep: DocumentsProgress;
};

const DOCUMENTS_ENDPOINT = "lista_dokumentow.php";

/**
 * Pobiera dokumenty dla zakresu dat w ramach budzetu czasu (config.toolBudgetMs).
 *
 * API FakturaXL wymusza okna <=31 dni ORAZ odstep 5s miedzy zapytaniami do
 * lista_dokumentow.php - odstep dotyczy calego endpointu, wiec okien nie da sie
 * zrownoleglic. Zapytanie o 2 lata to ~24 okna = ~120s, czyli powyzej timeoutu
 * klienta MCP. Dlatego przeszukujemy tyle okien, ile zmiesci sie w budzecie,
 * a reszte oddajemy agentowi jako kursor do kontynuacji.
 *
 * Gwarancja postepu: zawsze przetwarzamy co najmniej jedno okno, wiec kursor
 * zawsze idzie do przodu i agent nie moze wpasc w petle.
 */
export async function getDocuments(apiToken: string, query: DocumentsQuery): Promise<DocumentsResult> {
  const startedAt = Date.now();
  const { chunks, warnings } = chunkDateRange(query.data_od, query.data_do, config.maxRangeMonths);

  const startIndex = resolveStartIndex(chunks, query.kursor);
  if (startIndex >= chunks.length) {
    return {
      docs: [],
      warnings: [...warnings, `Kursor ${query.kursor} wykracza za koniec zakresu - nie ma nic więcej do pobrania.`],
      zakres_przeszukany: { data_od: query.data_do, data_do: query.data_do },
      kursor_nastepny: null,
      ukonczono: true,
      postep: progressOf(chunks.length, chunks.length, 0),
    };
  }

  const baseParams: XmlParams = {
    api_token: apiToken,
    status: query.status,
    wybrany_typ_dokumentu: query.typ,
    rodzaj_faktury_koszty: query.rodzaj_faktury_koszty,
    id_dzialy_firmy: query.id_dzialy_firmy,
  };

  // Filtr klienta rozwiazujemy PRZED petla: lista klientow to endpoint 10s, wiec
  // jej koszt musi byc wliczony w budzet, a nie doliczony po jego wyczerpaniu.
  const clientQuery = query.klient?.trim();
  const clientIds = clientQuery ? await resolveClientIds(apiToken, clientQuery) : undefined;

  const all: Doc[] = [];
  let index = startIndex;
  let budgetExhausted = false;
  let maxWindowMs = 0;

  while (index < chunks.length) {
    if (index > startIndex && !fitsInBudget(apiToken, startedAt, maxWindowMs)) {
      budgetExhausted = true;
      break;
    }
    const chunk = chunks[index];
    const windowStartedAt = Date.now();
    const items = (await fetchAllPages(DOCUMENTS_ENDPOINT, "dokument", {
      ...baseParams,
      data_od: chunk.data_od,
      data_do: chunk.data_do,
    })) as Doc[];
    maxWindowMs = Math.max(maxWindowMs, Date.now() - windowStartedAt);
    all.push(...items);
    index += 1;
  }

  const docs = clientQuery ? filterByClient(all, clientQuery, clientIds ?? new Set()) : all;
  const ukonczono = index >= chunks.length;
  const kursorNastepny = ukonczono ? null : chunks[index].data_od;

  if (clientQuery && docs.length === 0) {
    warnings.push(`Brak dokumentów dla klienta pasującego do "${clientQuery}" w przeszukanym zakresie.`);
  }
  if (budgetExhausted) {
    warnings.push(
      `DANE CZĘŚCIOWE - nie przedstawiaj ich jako kompletnej odpowiedzi. Przeszukano ${index} z ${chunks.length} ` +
        `okien (do ${chunks[index - 1].data_do}). Aby dokończyć, wywołaj to narzędzie ponownie z tym samym ` +
        `zakresem i parametrem kursor="${kursorNastepny}", a wyniki scal (sumy z kolejnych wywołań dodaj).`,
    );
  }

  return {
    docs,
    warnings,
    zakres_przeszukany: { data_od: chunks[startIndex].data_od, data_do: chunks[index - 1].data_do },
    kursor_nastepny: kursorNastepny,
    ukonczono,
    postep: progressOf(chunks.length, index, index - startIndex),
  };
}

/**
 * Czy zmiesci sie kolejne okno. Koszt szacujemy dwutorowo: z odstepu, ktory naliczy
 * limiter, oraz z najdrozszego okna zmierzonego w tym wywolaniu - to drugie lapie
 * okna wielostronicowe (>500 dokumentow w miesiacu), gdzie kazda kolejna strona
 * to dodatkowe 5s i sam odstep limitera zanizalby wycene.
 */
function fitsInBudget(apiToken: string, startedAt: number, maxWindowMs: number): boolean {
  const RESPONSE_MARGIN_MS = 1000;
  const elapsed = Date.now() - startedAt;
  const fromLimiter = rateLimiter.nextWaitMs(apiToken, DOCUMENTS_ENDPOINT) + RESPONSE_MARGIN_MS;
  const nextCost = Math.max(fromLimiter, maxWindowMs);
  return elapsed + nextCost <= config.toolBudgetMs;
}

/** Znajduje indeks okna, od ktorego kontynuowac. Bez kursora - od poczatku zakresu. */
function resolveStartIndex(chunks: { data_od: string; data_do: string }[], kursor?: string): number {
  if (!kursor?.trim()) return 0;
  const found = chunks.findIndex((c) => c.data_do >= kursor);
  return found === -1 ? chunks.length : found;
}

function progressOf(total: number, searched: number, inThisCall: number): DocumentsProgress {
  const pozostalo = Math.max(0, total - searched);
  return {
    okien_lacznie: total,
    okien_przeszukanych_lacznie: searched,
    okien_w_tym_wywolaniu: inThisCall,
    okien_pozostalo: pozostalo,
    szacowany_czas_pozostaly_s: Math.round((pozostalo * intervalFor(DOCUMENTS_ENDPOINT)) / 1000),
  };
}

/** ID klientow pasujacych do zapytania (nazwa/NIP) - z cache listy klientow. */
async function resolveClientIds(apiToken: string, query: string): Promise<Set<string>> {
  const matched = await findClients(apiToken, query);
  return new Set(matched.map((c) => s(c.id)));
}

/** Filtr po kliencie: dopasowuje po klient_id oraz po nazwie odbiorcy na dokumencie. */
function filterByClient(docs: Doc[], query: string, ids: Set<string>): Doc[] {
  const q = norm(query);
  return docs.filter((d) => {
    if (ids.has(s(d.klient_id))) return true;
    return norm(s(d.nazwa_skrocona_odbiorcy)).includes(q);
  });
}

// --- Proste listy (magazyny, dzialy) ---

export async function getWarehouses(apiToken: string): Promise<Doc[]> {
  return cache.getOrLoad(`warehouses:${apiToken}`, async () => {
    const raw = (await fakturaXlCall("lista_magazynow.php", { api_token: apiToken })) as {
      dokumenty?: { magazyn?: unknown };
    };
    return toArray(raw?.dokumenty?.magazyn) as Doc[];
  });
}

export async function getDepartments(apiToken: string): Promise<Doc[]> {
  return cache.getOrLoad(`departments:${apiToken}`, async () => {
    const raw = (await fakturaXlCall("dokument_lista_dzialow.php", { api_token: apiToken })) as {
      dokument?: { dzial?: unknown };
    };
    return toArray(raw?.dokument?.dzial) as Doc[];
  });
}

export async function getStock(apiToken: string): Promise<Doc[]> {
  return (await fetchAllPages("ilosc_produktow_w_magazynie.php", "produkt", { api_token: apiToken })) as Doc[];
}
