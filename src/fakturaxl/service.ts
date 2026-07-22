import { config } from "../config.js";
import { cache } from "./cache.js";
import type { Doc } from "./compact.js";
import { chunkDateRange } from "./dates.js";
import { fetchAllPages, toArray } from "./pagination.js";
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
  klient?: string;
  status?: string | number;
  typ?: string | number;
  rodzaj_faktury_koszty?: string | number;
  id_dzialy_firmy?: string | number;
};

export type DocumentsResult = {
  docs: Doc[];
  warnings: string[];
};

/**
 * Pobiera dokumenty dla dowolnego zakresu dat: wewnetrznie chunkuje (<=31 dni),
 * auto-paginuje i (opcjonalnie) filtruje po kliencie (nazwa/NIP). Filtry
 * status/typ/rodzaj sa przekazywane do API (mniej danych po stronie zrodla).
 */
export async function getDocuments(apiToken: string, query: DocumentsQuery): Promise<DocumentsResult> {
  const { chunks, warnings } = chunkDateRange(query.data_od, query.data_do, config.maxRangeMonths);

  const baseParams: XmlParams = {
    api_token: apiToken,
    status: query.status,
    wybrany_typ_dokumentu: query.typ,
    rodzaj_faktury_koszty: query.rodzaj_faktury_koszty,
    id_dzialy_firmy: query.id_dzialy_firmy,
  };

  const all: Doc[] = [];
  for (const chunk of chunks) {
    const items = (await fetchAllPages("lista_dokumentow.php", "dokument", {
      ...baseParams,
      data_od: chunk.data_od,
      data_do: chunk.data_do,
    })) as Doc[];
    all.push(...items);
  }

  let docs = all;
  if (query.klient && query.klient.trim()) {
    docs = await filterByClient(apiToken, all, query.klient.trim());
    if (docs.length === 0) {
      warnings.push(`Brak dokumentów dla klienta pasującego do "${query.klient}" w podanym zakresie.`);
    }
  }

  return { docs, warnings };
}

/** Filtr po kliencie: dopasowuje po klient_id (z listy klientow) oraz po nazwie na dokumencie. */
async function filterByClient(apiToken: string, docs: Doc[], query: string): Promise<Doc[]> {
  const matched = await findClients(apiToken, query);
  const ids = new Set(matched.map((c) => s(c.id)));
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
