import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { logger } from "../logger.js";
import { FakturaXlError, fakturaXlCall } from "../fakturaxl/client.js";
import { createDraft, draftExpiresAt, getDraft, markIssued } from "../fakturaxl/drafts.js";
import { buildPodglad, buildXmlPayload, fakturaSchema, walidujFakture, type Podglad } from "../fakturaxl/invoice.js";
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
        walidujFakture(args);
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

        const platnosc = await upewnijSieOplacona(apiToken, wynik.dokument_id, draft.podglad);
        return {
          status: "WYSTAWIONA",
          ...wynik,
          platnosc,
          suma_brutto: draft.podglad.suma_brutto,
          waluta: draft.podglad.waluta,
          uwaga: "Dokument jest wystawiony. Kwoty ostateczne sprawdzisz przez 'pobierz_dokument'.",
        };
      }),
  );
}

type WynikPlatnosci = {
  status: "nieopłacona" | "opłacona" | "częściowo opłacona" | "nie sprawdzono";
  ustawiono_recznie?: boolean;
  uwaga?: string;
};

const STATUSY: Record<string, WynikPlatnosci["status"]> = {
  "0": "nieopłacona",
  "1": "częściowo opłacona",
  "2": "opłacona",
};

/**
 * Dokumentacja FakturaXL pokazuje kwota_oplacona/data_oplacenia w przykladzie
 * dokument_dodaj.php, ale nie opisuje, czy to ustawia status "oplacona".
 * Dlatego po wystawieniu sprawdzamy status i - jesli trzeba - ustawiamy go
 * przez dokument_edycja.php (status=2), tak jak opisuje to dokumentacja.
 * Faktura jest juz wystawiona, wiec bledy tutaj NIE moga przerwac narzedzia.
 */
async function upewnijSieOplacona(apiToken: string, dokumentId: string, podglad: Podglad): Promise<WynikPlatnosci> {
  if (podglad.platnosc.status !== "opłacona" || dokumentId === "") {
    return { status: podglad.platnosc.status };
  }
  try {
    const odczyt = (await fakturaXlCall("dokument_odczytaj.php", { api_token: apiToken, dokument_id: dokumentId })) as {
      dokument?: { status?: unknown };
    };
    if (String(odczyt?.dokument?.status ?? "") === "2") return { status: "opłacona" };

    await fakturaXlCall("dokument_edycja.php", {
      api_token: apiToken,
      dokument_id: dokumentId,
      status: 2,
      data_oplacenia: podglad.platnosc.data_oplacenia,
      rodzaj_platnosci: podglad.rodzaj_platnosci,
    });
    logger.info("mcp.invoice_marked_paid", { dokument_id: dokumentId });
    return { status: "opłacona", ustawiono_recznie: true };
  } catch (err) {
    // Kod 37 = "Dokument zostal juz wczesniej oplacony" - czyli dokladnie to, czego chcemy.
    if (err instanceof FakturaXlError && err.code === "37") return { status: "opłacona" };
    const message = err instanceof Error ? err.message : String(err);
    logger.error("mcp.invoice_mark_paid_failed", { dokument_id: dokumentId, error: message });
    return {
      status: "nie sprawdzono",
      uwaga: `Faktura wystawiona, ale nie udało się potwierdzić statusu "opłacona" (${message}). Sprawdź w FakturaXL.`,
    };
  }
}
