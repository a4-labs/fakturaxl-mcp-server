import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { logger } from "../logger.js";
import { fakturaXlCall } from "../fakturaxl/client.js";
import { createDraft, draftExpiresAt, getDraft, markIssued } from "../fakturaxl/drafts.js";
import { buildPodglad, buildXmlPayload, fakturaSchema } from "../fakturaxl/invoice.js";
import { tool } from "./runner.js";

const PRZYGOTUJ_OPIS =
  "KROK 1 z 2 - nic jeszcze nie wystawia. Waliduje dane, wylicza kwoty i zwraca podgląd faktury " +
  "wraz z 'token_potwierdzenia'. POKAŻ UŻYTKOWNIKOWI podgląd (nabywca, pozycje, suma brutto) " +
  "i POCZEKAJ na jego wyraźną zgodę. Dopiero potem wywołaj 'wystaw_fakture' z tym tokenem. " +
  "Nigdy nie wywołuj obu kroków pod rząd bez potwierdzenia użytkownika. " +
  "API nie przyjmuje klient_id, więc dane nabywcy przepisz z 'znajdz_klienta'.";

const WYSTAW_OPIS =
  "KROK 2 z 2 - NIEODWRACALNE. Wystawia fakturę przygotowaną przez 'przygotuj_fakture' i zużywa " +
  "numer z ciągłej numeracji. Wywołaj TYLKO po wyraźnym potwierdzeniu użytkownika. " +
  "Powtórne wywołanie z tym samym tokenem nie wystawi drugiej faktury - zwróci tę pierwszą.";

/**
 * Narzedzia ZAPISU - rejestrowane tylko przy ALLOW_WRITE=true.
 *
 * Wystawienie faktury jest nieodwracalne, a MCP nie ma UI z przyciskiem
 * potwierdzenia, dlatego bariera jest w protokole: dwa kroki i token, ktory
 * zapewnia jednoczesnie idempotencje wobec ponowien klienta MCP.
 */
export function registerWriteTools(server: McpServer, apiToken: string): void {
  server.registerTool(
    "przygotuj_fakture",
    {
      title: "Przygotuj fakturę VAT (podgląd, bez wystawienia)",
      description: PRZYGOTUJ_OPIS,
      inputSchema: fakturaSchema,
    },
    async (args) =>
      tool("przygotuj_fakture", args, async () => {
        const podglad = buildPodglad(args);
        const draft = createDraft(apiToken, buildXmlPayload(args, apiToken), podglad);
        return {
          status: "PRZYGOTOWANA - NIE WYSTAWIONA",
          podglad,
          token_potwierdzenia: draft.token,
          wygasa_o: draftExpiresAt(draft),
          nastepny_krok:
            "Pokaż użytkownikowi powyższy podgląd i zapytaj o zgodę. Po potwierdzeniu wywołaj " +
            "'wystaw_fakture' z tym 'token_potwierdzenia'.",
        };
      }),
  );

  server.registerTool(
    "wystaw_fakture",
    {
      title: "Wystaw przygotowaną fakturę (nieodwracalne)",
      description: WYSTAW_OPIS,
      inputSchema: {
        token_potwierdzenia: z.string().describe("Wartość 'token_potwierdzenia' z 'przygotuj_fakture'"),
        potwierdzam: z
          .literal(true)
          .describe("Musi być true i oznacza, że użytkownik wyraźnie potwierdził wystawienie faktury"),
      },
    },
    async (args) =>
      tool("wystaw_fakture", args, async () => {
        const draft = getDraft(args.token_potwierdzenia, apiToken);

        // Idempotencja: API FakturaXL jej nie ma, a klient MCP potrafi powtorzyc
        // wywolanie po timeoucie. Zuzyty draft zwraca pierwotny wynik.
        if (draft.wynik !== undefined) {
          logger.warn("mcp.invoice_duplicate_blocked", { token: draft.token });
          return {
            status: "JUŻ WYSTAWIONA",
            powtorzone_wywolanie: true,
            komunikat: "Ten token został już zużyty - zwracam fakturę wystawioną wcześniej, drugiej nie wystawiam.",
            wynik: draft.wynik,
          };
        }

        const odpowiedz = (await fakturaXlCall("dokument_dodaj.php", draft.payload)) as {
          dokument?: { dokument_id?: unknown; dokument_nr?: unknown; unikatowy_kod?: unknown };
        };
        const dokument = odpowiedz?.dokument ?? {};
        const wynik = {
          dokument_id: String(dokument.dokument_id ?? ""),
          numer_faktury: String(dokument.dokument_nr ?? ""),
          unikatowy_kod: String(dokument.unikatowy_kod ?? ""),
        };
        markIssued(draft, wynik);

        logger.info("mcp.invoice_issued", { ...wynik, suma_brutto: draft.podglad.suma_brutto });
        return {
          status: "WYSTAWIONA",
          ...wynik,
          suma_brutto: draft.podglad.suma_brutto,
          waluta: draft.podglad.waluta,
          uwaga: "Dokument jest wystawiony. Kwoty ostateczne sprawdzisz przez 'pobierz_dokument'.",
        };
      }),
  );
}
