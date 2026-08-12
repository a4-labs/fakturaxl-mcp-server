import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runInCallContext } from "../callContext.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
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

type Payload = Record<string, unknown>;

/**
 * Wykonuje narzedzie w kontekscie pomiarowym i loguje przebieg: argumenty na wejsciu,
 * a na wyjsciu czas trwania, liczbe zapytan do FakturaXL i to, czy zwrocono kursor.
 * Bez tego timeouty po stronie agenta byly w logach niewidoczne.
 */
async function tool(name: string, args: Payload, fn: () => Promise<Payload>): Promise<ToolResult> {
  return runInCallContext(async (ctx) => {
    logger.info("mcp.tool_call", { tool: name, args });
    try {
      const payload = await fn();
      const text = JSON.stringify(payload, null, 2);
      logger.info("mcp.tool_result", {
        tool: name,
        durationMs: Date.now() - ctx.startedAt,
        apiCalls: ctx.apiCalls,
        responseChars: text.length,
        liczba_zwrocona: payload.liczba_zwrocona,
        liczba_calkowita: payload.liczba_calkowita,
        ukonczono: payload.ukonczono,
        kursor_nastepny: payload.kursor_nastepny,
      });
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      const message = err instanceof FakturaXlError || err instanceof Error ? err.message : String(err);
      logger.error("mcp.tool_error", {
        tool: name,
        durationMs: Date.now() - ctx.startedAt,
        apiCalls: ctx.apiCalls,
        error: message,
      });
      return { isError: true, content: [{ type: "text" as const, text: `Błąd: ${message}` }] };
    }
  });
}

function clampLimit(limit?: number): number {
  return Math.min(limit ?? config.defaultListLimit, config.maxListLimit);
}

type PageMeta = { liczba_calkowita: number; liczba_zwrocona: number; has_more: boolean };

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

const limitParam = z
  .number()
  .int()
  .positive()
  .optional()
  .describe(`Maks. liczba zwracanych wierszy (domyślnie ${config.defaultListLimit}, max ${config.maxListLimit})`);

const docFilterSchema = {
  data_od: z.string().describe("Data początkowa YYYY-MM-DD (dowolny zakres - okna 31-dniowe robimy wewnętrznie)"),
  data_do: z.string().describe("Data końcowa YYYY-MM-DD"),
  kursor: z
    .string()
    .optional()
    .describe("Kontynuacja: wartość 'kursor_nastepny' z poprzedniego wywołania (YYYY-MM-DD). Za pierwszym razem pomiń."),
  klient: z.string().optional().describe("Filtr po kliencie: fragment nazwy lub NIP"),
  status: z.union([z.string(), z.number()]).optional().describe("0-Nieopłacona, 1-Częściowo, 2-Opłacona"),
  typ: z.union([z.string(), z.number()]).optional().describe("Typ dokumentu (wybrany_typ_dokumentu, patrz słowniki)"),
  rodzaj_faktury_koszty: z.union([z.string(), z.number()]).optional().describe("1-przychodowe, 2-kosztowe"),
  id_dzialy_firmy: z.union([z.string(), z.number()]).optional().describe("ID działu firmy"),
};

// API FakturaXL wymusza okna <=31 dni i odstep 5s miedzy zapytaniami o dokumenty,
// wiec szeroki zakres nie zmiesci sie w jednym wywolaniu. Opis musi wprost nakazac
// agentowi kontynuacje kursorem, inaczej przedstawi dane czesciowe jako pelne.
const CURSOR_INSTRUCTION =
  "WAŻNE - dane mogą być częściowe: szeroki zakres dat jest przeszukiwany w oknach 31-dniowych, " +
  "a API FakturaXL wymusza 5 s przerwy między oknami (2 lata = ok. 120 s, powyżej limitu czasu). " +
  "Dlatego jedno wywołanie przeszukuje tylko tyle okien, ile zmieści się w budżecie czasu. " +
  "Jeśli w odpowiedzi 'ukonczono' = false, MUSISZ wywołać narzędzie ponownie z tym samym zakresem " +
  "i parametrem kursor = wartość 'kursor_nastepny', i powtarzać to aż 'ukonczono' = true. " +
  "Wyniki z kolejnych wywołań scal, a sumy z 'summary' dodaj. Nigdy nie przedstawiaj danych " +
  "z 'ukonczono' = false jako pełnej odpowiedzi - poinformuj, że pobieranie trwa, albo dokończ je.";

/**
 * Rejestruje narzedzia READ-ONLY dla danego klucza API. Warstwa praktyczna:
 * auto-paginacja, okna dat, throttling i filtrowanie sa ukryte przed agentem;
 * na zewnatrz wystawiony jest tylko kursor do kontynuacji dlugich zakresow.
 */
export function registerReadOnlyTools(server: McpServer, apiToken: string): void {
  server.registerTool(
    "lista_dokumentow",
    {
      title: "Lista dokumentów",
      description:
        "Zwraca faktury/dokumenty dla zakresu dat. Można filtrować po kliencie (nazwa/NIP), statusie, typie, " +
        `rodzaju. Zwraca compact + summary + has_more. ${CURSOR_INSTRUCTION}`,
      inputSchema: { ...docFilterSchema, limit: limitParam },
    },
    async (args) =>
      tool("lista_dokumentow", args, async () => {
        const { data_od, data_do, kursor, klient, status, typ, rodzaj_faktury_koszty, id_dzialy_firmy, limit } = args;
        const result = await getDocuments(apiToken, {
          data_od,
          data_do,
          kursor,
          klient,
          status,
          typ,
          rodzaj_faktury_koszty,
          id_dzialy_firmy,
        });
        const { meta, rows } = paginate(result.docs.map(compactDoc), clampLimit(limit));
        return {
          zakres_zadany: { data_od, data_do },
          zakres_przeszukany: result.zakres_przeszukany,
          ukonczono: result.ukonczono,
          kursor_nastepny: result.kursor_nastepny,
          postep: result.postep,
          filtr: { klient, status, typ, rodzaj_faktury_koszty, id_dzialy_firmy },
          summary: summarizeDocuments(result.docs),
          ostrzezenia: result.warnings,
          ...meta,
          dokumenty: rows,
        };
      }),
  );

  server.registerTool(
    "podsumowanie_dokumentow",
    {
      title: "Podsumowanie dokumentów (agregaty)",
      description:
        "Zwraca WYŁĄCZNIE agregaty (liczba, sumy netto/vat/brutto per waluta, rozkład statusów/rodzajów) " +
        `dla zakresu dat i filtrów - bez listy wierszy. Idealne do pytań 'ile/za ile w okresie'. ${CURSOR_INSTRUCTION}`,
      inputSchema: docFilterSchema,
    },
    async (args) =>
      tool("podsumowanie_dokumentow", args, async () => {
        const { data_od, data_do, kursor, klient, status, typ, rodzaj_faktury_koszty, id_dzialy_firmy } = args;
        const result = await getDocuments(apiToken, {
          data_od,
          data_do,
          kursor,
          klient,
          status,
          typ,
          rodzaj_faktury_koszty,
          id_dzialy_firmy,
        });
        return {
          zakres_zadany: { data_od, data_do },
          zakres_przeszukany: result.zakres_przeszukany,
          ukonczono: result.ukonczono,
          kursor_nastepny: result.kursor_nastepny,
          postep: result.postep,
          filtr: { klient, status, typ, rodzaj_faktury_koszty, id_dzialy_firmy },
          summary: summarizeDocuments(result.docs),
          ostrzezenia: result.warnings,
        };
      }),
  );

  server.registerTool(
    "pobierz_dokument",
    {
      title: "Pobierz dane dokumentu",
      description: "Pełne dane pojedynczego dokumentu po ID (wszystkie pola, pozycje, sprzedawca/nabywca).",
      inputSchema: { dokument_id: z.union([z.string(), z.number()]).describe("ID dokumentu") },
    },
    async (args) =>
      tool("pobierz_dokument", args, async () => ({
        dokument: await fakturaXlCall("dokument_odczytaj.php", { api_token: apiToken, dokument_id: args.dokument_id }),
      })),
  );

  server.registerTool(
    "pobierz_pdf",
    {
      title: "Pobierz PDF dokumentu (base64)",
      description: "Zwraca plik PDF dokumentu zakodowany w base64 (pole <pdf>).",
      inputSchema: { dokument_id: z.union([z.string(), z.number()]).describe("ID dokumentu") },
    },
    async (args) =>
      tool("pobierz_pdf", args, async () => ({
        pdf: await fakturaXlCall("pdf_p.php", { api_token: apiToken, dokument_id: args.dokument_id }),
      })),
  );

  server.registerTool(
    "znajdz_klienta",
    {
      title: "Znajdź klienta",
      description: "Wyszukuje klientów po fragmencie nazwy lub NIP. Zwraca dopasowania z ID.",
      inputSchema: { szukaj: z.string().describe("Fragment nazwy lub NIP klienta"), limit: limitParam },
    },
    async (args) =>
      tool("znajdz_klienta", args, async () => {
        const found = await findClients(apiToken, args.szukaj);
        const { meta, rows } = paginate(found.map(compactClient), clampLimit(args.limit));
        return { szukaj: args.szukaj, ...meta, klienci: rows };
      }),
  );

  server.registerTool(
    "lista_klientow",
    {
      title: "Lista klientów",
      description: "Lista klientów (compact). Opcjonalnie filtruj fragmentem nazwy/NIP przez 'szukaj'.",
      inputSchema: { szukaj: z.string().optional().describe("Opcjonalny filtr: nazwa lub NIP"), limit: limitParam },
    },
    async (args) =>
      tool("lista_klientow", args, async () => {
        const clients = args.szukaj?.trim() ? await findClients(apiToken, args.szukaj) : await getAllClients(apiToken);
        const { meta, rows } = paginate(clients.map(compactClient), clampLimit(args.limit));
        return { ...meta, klienci: rows };
      }),
  );

  server.registerTool(
    "znajdz_produkt",
    {
      title: "Znajdź produkt",
      description: "Wyszukuje produkty po fragmencie nazwy, kodzie produktu lub kodzie kreskowym.",
      inputSchema: { szukaj: z.string().describe("Fragment nazwy / kod produktu / kod kreskowy"), limit: limitParam },
    },
    async (args) =>
      tool("znajdz_produkt", args, async () => {
        const found = await findProducts(apiToken, args.szukaj);
        const { meta, rows } = paginate(found.map(compactProduct), clampLimit(args.limit));
        return { szukaj: args.szukaj, ...meta, produkty: rows };
      }),
  );

  server.registerTool(
    "lista_produktow",
    {
      title: "Lista produktów",
      description: "Lista produktów (compact). Opcjonalnie filtruj przez 'szukaj'.",
      inputSchema: { szukaj: z.string().optional().describe("Opcjonalny filtr: nazwa/kod"), limit: limitParam },
    },
    async (args) =>
      tool("lista_produktow", args, async () => {
        const products = args.szukaj?.trim()
          ? await findProducts(apiToken, args.szukaj)
          : await getAllProducts(apiToken);
        const { meta, rows } = paginate(products.map(compactProduct), clampLimit(args.limit));
        return { ...meta, produkty: rows };
      }),
  );

  server.registerTool(
    "stany_magazynowe",
    {
      title: "Stany magazynowe",
      description: "Ilości produktów w magazynach (auto-paginacja). Zwraca produkt_id, magazyn_id, ilość.",
      inputSchema: { limit: limitParam },
    },
    async (args) =>
      tool("stany_magazynowe", args, async () => {
        const rows = (await getStock(apiToken)).map((r) => ({
          produkt_id: String(r.produkt_id ?? ""),
          magazyn_id: String(r.magazyn_id ?? ""),
          ilosc_w_magazynie: String(r.ilosc_w_magazynie ?? ""),
        }));
        const { meta, rows: paged } = paginate(rows, clampLimit(args.limit));
        return { ...meta, stany: paged };
      }),
  );

  server.registerTool(
    "lista_magazynow",
    {
      title: "Lista magazynów",
      description: "Lista magazynów (id, nazwa, czy główny).",
      inputSchema: {},
    },
    async (args) =>
      tool("lista_magazynow", args, async () => ({
        magazyny: (await getWarehouses(apiToken)).map((m) => ({
          id: String(m.id ?? ""),
          nazwa: String(m.nazwa ?? ""),
          magazyn_glowny: String(m.magazyn_glowny ?? ""),
        })),
      })),
  );

  server.registerTool(
    "lista_dzialow",
    {
      title: "Lista działów firmy",
      description: "Lista działów firmy (id, nazwa).",
      inputSchema: {},
    },
    async (args) =>
      tool("lista_dzialow", args, async () => ({
        dzialy: (await getDepartments(apiToken)).map((d) => ({
          id: String(d.id ?? ""),
          nazwa: String(d.nazwa ?? ""),
        })),
      })),
  );
}
