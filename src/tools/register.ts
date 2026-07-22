import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config } from "../config.js";
import { FakturaXlError, fakturaXlCall } from "../fakturaxl/client.js";
import { compactClient, compactDoc, compactProduct, summarizeDocuments, type Doc } from "../fakturaxl/compact.js";
import {
  findClients,
  findProducts,
  getAllClients,
  getAllProducts,
  getDepartments,
  getDocuments,
  getStock,
  getWarehouses,
} from "../fakturaxl/service.js";

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function ok(payload: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function fail(message: string): ToolResult {
  return { isError: true, content: [{ type: "text", text: `Błąd: ${message}` }] };
}

async function guard(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof FakturaXlError || err instanceof Error ? err.message : String(err);
    return fail(message);
  }
}

function clampLimit(limit?: number): number {
  return Math.min(limit ?? config.defaultListLimit, config.maxListLimit);
}

/** Ogranicza liczbe zwracanych wierszy i zwraca metadane obciecia osobno od wierszy. */
function paginate(rows: Doc[], limit: number): { meta: PageMeta; rows: Doc[] } {
  const zwrocone = rows.slice(0, limit);
  return {
    meta: {
      liczba_calkowita: rows.length,
      liczba_zwrocona: zwrocone.length,
      has_more: rows.length > zwrocone.length,
    },
    rows: zwrocone,
  };
}

type PageMeta = { liczba_calkowita: number; liczba_zwrocona: number; has_more: boolean };

const limitParam = z
  .number()
  .int()
  .positive()
  .optional()
  .describe(`Maks. liczba zwracanych wierszy (domyślnie ${config.defaultListLimit}, max ${config.maxListLimit})`);

const docFilterSchema = {
  data_od: z.string().describe("Data początkowa YYYY-MM-DD (dowolny zakres - chunking robimy wewnętrznie)"),
  data_do: z.string().describe("Data końcowa YYYY-MM-DD"),
  klient: z.string().optional().describe("Filtr po kliencie: fragment nazwy lub NIP"),
  status: z.union([z.string(), z.number()]).optional().describe("0-Nieopłacona, 1-Częściowo, 2-Opłacona"),
  typ: z.union([z.string(), z.number()]).optional().describe("Typ dokumentu (wybrany_typ_dokumentu, patrz słowniki)"),
  rodzaj_faktury_koszty: z.union([z.string(), z.number()]).optional().describe("1-przychodowe, 2-kosztowe"),
  id_dzialy_firmy: z.union([z.string(), z.number()]).optional().describe("ID działu firmy"),
};

/**
 * Rejestruje narzedzia READ-ONLY dla danego klucza API. Warstwa praktyczna:
 * auto-paginacja, chunking dat, throttling i filtrowanie sa ukryte przed agentem.
 */
export function registerReadOnlyTools(server: McpServer, apiToken: string): void {
  server.registerTool(
    "lista_dokumentow",
    {
      title: "Lista dokumentów",
      description:
        "Zwraca faktury/dokumenty dla dowolnego zakresu dat (limit 31 dni i paginacja obsługiwane wewnętrznie). " +
        "Można filtrować po kliencie (nazwa/NIP), statusie, typie, rodzaju. Zwraca compact + summary + has_more.",
      inputSchema: { ...docFilterSchema, limit: limitParam },
    },
    async ({ data_od, data_do, klient, status, typ, rodzaj_faktury_koszty, id_dzialy_firmy, limit }) =>
      guard(async () => {
        const { docs, warnings } = await getDocuments(apiToken, {
          data_od,
          data_do,
          klient,
          status,
          typ,
          rodzaj_faktury_koszty,
          id_dzialy_firmy,
        });
        const summary = summarizeDocuments(docs);
        const { meta, rows } = paginate(docs.map(compactDoc), clampLimit(limit));
        return ok({
          zakres: { data_od, data_do },
          filtr: { klient, status, typ, rodzaj_faktury_koszty, id_dzialy_firmy },
          summary,
          ostrzezenia: warnings,
          ...meta,
          dokumenty: rows,
        });
      }),
  );

  server.registerTool(
    "podsumowanie_dokumentow",
    {
      title: "Podsumowanie dokumentów (agregaty)",
      description:
        "Zwraca WYŁĄCZNIE agregaty (liczba, sumy netto/vat/brutto per waluta, rozkład statusów/rodzajów) " +
        "dla zakresu dat i filtrów - bez listy wierszy. Idealne do pytań 'ile/za ile w okresie'.",
      inputSchema: docFilterSchema,
    },
    async ({ data_od, data_do, klient, status, typ, rodzaj_faktury_koszty, id_dzialy_firmy }) =>
      guard(async () => {
        const { docs, warnings } = await getDocuments(apiToken, {
          data_od,
          data_do,
          klient,
          status,
          typ,
          rodzaj_faktury_koszty,
          id_dzialy_firmy,
        });
        return ok({
          zakres: { data_od, data_do },
          filtr: { klient, status, typ, rodzaj_faktury_koszty, id_dzialy_firmy },
          summary: summarizeDocuments(docs),
          ostrzezenia: warnings,
        });
      }),
  );

  server.registerTool(
    "pobierz_dokument",
    {
      title: "Pobierz dane dokumentu",
      description: "Pełne dane pojedynczego dokumentu po ID (wszystkie pola, pozycje, sprzedawca/nabywca).",
      inputSchema: { dokument_id: z.union([z.string(), z.number()]).describe("ID dokumentu") },
    },
    async ({ dokument_id }) =>
      guard(async () => ok(await fakturaXlCall("dokument_odczytaj.php", { api_token: apiToken, dokument_id }))),
  );

  server.registerTool(
    "pobierz_pdf",
    {
      title: "Pobierz PDF dokumentu (base64)",
      description: "Zwraca plik PDF dokumentu zakodowany w base64 (pole <pdf>).",
      inputSchema: { dokument_id: z.union([z.string(), z.number()]).describe("ID dokumentu") },
    },
    async ({ dokument_id }) =>
      guard(async () => ok(await fakturaXlCall("pdf_p.php", { api_token: apiToken, dokument_id }))),
  );

  server.registerTool(
    "znajdz_klienta",
    {
      title: "Znajdź klienta",
      description: "Wyszukuje klientów po fragmencie nazwy lub NIP. Zwraca dopasowania z ID.",
      inputSchema: { szukaj: z.string().describe("Fragment nazwy lub NIP klienta"), limit: limitParam },
    },
    async ({ szukaj, limit }) =>
      guard(async () => {
        const { meta, rows } = paginate((await findClients(apiToken, szukaj)).map(compactClient), clampLimit(limit));
        return ok({ szukaj, ...meta, klienci: rows });
      }),
  );

  server.registerTool(
    "lista_klientow",
    {
      title: "Lista klientów",
      description: "Lista klientów (compact). Opcjonalnie filtruj fragmentem nazwy/NIP przez 'szukaj'.",
      inputSchema: { szukaj: z.string().optional().describe("Opcjonalny filtr: nazwa lub NIP"), limit: limitParam },
    },
    async ({ szukaj, limit }) =>
      guard(async () => {
        const clients = szukaj?.trim() ? await findClients(apiToken, szukaj) : await getAllClients(apiToken);
        const { meta, rows } = paginate(clients.map(compactClient), clampLimit(limit));
        return ok({ ...meta, klienci: rows });
      }),
  );

  server.registerTool(
    "znajdz_produkt",
    {
      title: "Znajdź produkt",
      description: "Wyszukuje produkty po fragmencie nazwy, kodzie produktu lub kodzie kreskowym.",
      inputSchema: { szukaj: z.string().describe("Fragment nazwy / kod produktu / kod kreskowy"), limit: limitParam },
    },
    async ({ szukaj, limit }) =>
      guard(async () => {
        const { meta, rows } = paginate((await findProducts(apiToken, szukaj)).map(compactProduct), clampLimit(limit));
        return ok({ szukaj, ...meta, produkty: rows });
      }),
  );

  server.registerTool(
    "lista_produktow",
    {
      title: "Lista produktów",
      description: "Lista produktów (compact). Opcjonalnie filtruj przez 'szukaj'.",
      inputSchema: { szukaj: z.string().optional().describe("Opcjonalny filtr: nazwa/kod"), limit: limitParam },
    },
    async ({ szukaj, limit }) =>
      guard(async () => {
        const products = szukaj?.trim() ? await findProducts(apiToken, szukaj) : await getAllProducts(apiToken);
        const { meta, rows } = paginate(products.map(compactProduct), clampLimit(limit));
        return ok({ ...meta, produkty: rows });
      }),
  );

  server.registerTool(
    "stany_magazynowe",
    {
      title: "Stany magazynowe",
      description: "Ilości produktów w magazynach (auto-paginacja). Zwraca produkt_id, magazyn_id, ilość.",
      inputSchema: { limit: limitParam },
    },
    async ({ limit }) =>
      guard(async () => {
        const rows = (await getStock(apiToken)).map((r) => ({
          produkt_id: String(r.produkt_id ?? ""),
          magazyn_id: String(r.magazyn_id ?? ""),
          ilosc_w_magazynie: String(r.ilosc_w_magazynie ?? ""),
        }));
        const { meta, rows: paged } = paginate(rows, clampLimit(limit));
        return ok({ ...meta, stany: paged });
      }),
  );

  server.registerTool(
    "lista_magazynow",
    {
      title: "Lista magazynów",
      description: "Lista magazynów (id, nazwa, czy główny).",
      inputSchema: {},
    },
    async () =>
      guard(async () =>
        ok({
          magazyny: (await getWarehouses(apiToken)).map((m) => ({
            id: String(m.id ?? ""),
            nazwa: String(m.nazwa ?? ""),
            magazyn_glowny: String(m.magazyn_glowny ?? ""),
          })),
        }),
      ),
  );

  server.registerTool(
    "lista_dzialow",
    {
      title: "Lista działów firmy",
      description: "Lista działów firmy (id, nazwa).",
      inputSchema: {},
    },
    async () =>
      guard(async () =>
        ok({
          dzialy: (await getDepartments(apiToken)).map((d) => ({
            id: String(d.id ?? ""),
            nazwa: String(d.nazwa ?? ""),
          })),
        }),
      ),
  );
}
