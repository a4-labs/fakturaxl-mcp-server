import { z } from "zod";
import type { XmlParams } from "./client.js";

/**
 * Wystawianie Faktury VAT (typ_faktury=0) przez dokument_dodaj.php.
 *
 * Kształt wymagań ustalony sonda na zywym API, nie z dokumentacji - dokument
 * bez kraju nabywcy, dat, waluty i rodzaju platnosci zwraca kody 11/13/15/18,
 * dlatego wszystkie te pola maja tu wartosci domyslne.
 *
 * Pulapki potwierdzone sonda:
 * - <nabywca><klient_id> NIE jest obslugiwane na wejsciu (kody 9 i 11) - trzeba
 *   przepisac pelne dane nabywcy. API samo dopasowuje klienta po NIP i wpisuje
 *   klient_id do wystawionego dokumentu, wiec duplikaty klientow nie powstaja.
 * - lista_klientow zwraca kraj jako <kraj_id>, ale dokument_dodaj oczekuje <kraj>.
 */

export const RODZAJE_PLATNOSCI = [
  "Przelew",
  "Gotówka",
  "Karta płatnicza",
  "Barter",
  "BLIK",
  "Czek",
  "DotPay",
  "Kompensata",
  "Opłata za pobraniem",
  "PayPal",
  "PayU",
  "Płatność elektroniczna",
  "Przelewy24",
  "Bon",
  "Kredyt",
  "Mobilna",
] as const;

/** Daty w API FakturaXL musza miec postac RRRR-MM-DD (inaczej kod 13). */
const dataSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data musi mieć postać RRRR-MM-DD");

const pozycjaSchema = z
  .object({
    nazwa: z.string().min(1).describe("Nazwa pozycji na fakturze"),
    ilosc: z.number().positive().default(1).describe("Ilość"),
    jm: z.string().default("szt.").describe("Jednostka miary"),
    vat: z.union([z.number(), z.string()]).default(23).describe("Stawka VAT: liczba (23, 8, 0) lub 'zw' / 'np'"),
    cena_netto: z.number().positive().optional().describe("Cena jednostkowa netto - użyj TEGO albo 'wartosc_brutto'"),
    rabat: z.number().min(0).max(100).optional().describe("Rabat procentowy (tylko z 'cena_netto')"),
    wartosc_brutto: z.number().positive().optional().describe("Całkowita wartość brutto pozycji"),
    pkwiu: z.string().optional().describe("PKWiU"),
  })
  .refine((p) => (p.cena_netto === undefined) !== (p.wartosc_brutto === undefined), {
    message: "Podaj dokładnie jedno: 'cena_netto' albo 'wartosc_brutto'",
  })
  .refine((p) => p.rabat === undefined || p.cena_netto !== undefined, {
    message: "'rabat' działa tylko razem z 'cena_netto'",
  });

const nabywcaSchema = z.object({
  nazwa: z.string().min(1).describe("Nazwa nabywcy (wymagana przez API)"),
  nip: z.string().optional().describe("NIP - po nim API dopasuje istniejącego klienta"),
  ulica_i_numer: z.string().optional(),
  kod_pocztowy: z.string().optional(),
  miejscowosc: z.string().optional(),
  kraj: z.string().length(2).default("PL").describe("Kod kraju, 2 litery"),
  email: z.string().optional(),
  osoba_prywatna: z.boolean().default(false).describe("true = osoba prywatna, false = firma"),
});

export const fakturaSchema = {
  nabywca: nabywcaSchema.describe(
    "Dane nabywcy. API nie przyjmuje klient_id - najpierw znajdź klienta przez 'znajdz_klienta' i przepisz jego dane.",
  ),
  pozycje: z.array(pozycjaSchema).min(1).describe("Pozycje faktury (min. 1 - API wymaga, kod 71)"),
  data_wystawienia: z.string().optional().describe("YYYY-MM-DD, domyślnie dzisiaj"),
  data_sprzedazy: z.string().optional().describe("YYYY-MM-DD, domyślnie = data wystawienia"),
  termin_platnosci_data: z.string().optional().describe("YYYY-MM-DD, domyślnie data wystawienia + 'termin_dni'"),
  termin_dni: z.number().int().min(0).default(14).describe("Liczba dni na płatność, gdy nie podano daty terminu"),
  waluta: z.string().length(3).default("PLN").describe("Kod waluty, np. PLN, EUR"),
  rodzaj_platnosci: z.enum(RODZAJE_PLATNOSCI).default("Przelew").describe("Rodzaj płatności"),
  uwagi: z.string().optional().describe("Uwagi na dokumencie"),
  miejsce_wystawienia: z.string().optional(),
  id_dzialy_firmy: z.union([z.string(), z.number()]).optional().describe("ID działu firmy (patrz 'lista_dzialow')"),
  oplacona: z
    .boolean()
    .default(false)
    .describe("true = faktura opłacona w całości (np. zamówienie ze sklepu opłacone BLIK-iem); kwota opłacona = suma brutto"),
  kwota_oplacona: z
    .number()
    .positive()
    .optional()
    .describe("Kwota częściowej wpłaty - zamiast 'oplacona', gdy zapłacono tylko część"),
  data_oplacenia: dataSchema
    .optional()
    .describe("YYYY-MM-DD, domyślnie data sprzedaży (używane z 'oplacona' albo 'kwota_oplacona')"),
  nr_zamowienia: z.string().optional().describe("Numer zamówienia, np. ze sklepu WooCommerce"),
  data_zamowienia: dataSchema.optional().describe("YYYY-MM-DD - data zamówienia"),
  imie_nazwisko_wystawcy: z.string().optional().describe("Imię i nazwisko osoby wystawiającej"),
};

const fakturaObject = z.object(fakturaSchema);
export type FakturaInput = z.infer<typeof fakturaObject>;

/**
 * Walidacja zaleznosci miedzy polami - schemat narzedzia MCP musi byc plaskim
 * obiektem pol, wiec refine na calym obiekcie robimy tu, w handlerze.
 */
export function walidujFakture(input: FakturaInput): void {
  if (input.oplacona && input.kwota_oplacona !== undefined) {
    throw new Error("Podaj 'oplacona' albo 'kwota_oplacona', nie oba naraz");
  }
  if (input.data_oplacenia !== undefined && !input.oplacona && input.kwota_oplacona === undefined) {
    throw new Error("'data_oplacenia' ma sens tylko z 'oplacona' albo 'kwota_oplacona'");
  }
}
type Pozycja = z.infer<typeof pozycjaSchema>;

/** Kwoty trzymamy w groszach - na floatach sumy pozycji rozjezdzaja sie o grosze. */
const gr = (value: number): number => Math.round(value * 100);
const zl = (grosze: number): string => (grosze / 100).toFixed(2);

/** Stawki 'zw' / 'np' nie sa liczba - do wyliczen traktujemy je jak 0%. */
function stawkaVat(vat: number | string): number {
  const parsed = typeof vat === "number" ? vat : Number.parseFloat(vat);
  return Number.isFinite(parsed) ? parsed : 0;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

type KwotyPozycji = { netto_gr: number; vat_gr: number; brutto_gr: number };

/**
 * Orientacyjne kwoty pozycji do podgladu. Ostateczne wartosci liczy FakturaXL -
 * te sluza tylko temu, zeby uzytkownik zobaczyl kwote PRZED wystawieniem.
 * Formula dla cena_netto + rabat zweryfikowana sonda: 2 x 100 netto - 10%
 * dalo netto 180.00, VAT 41.40, brutto 221.40.
 */
function policzPozycje(p: Pozycja): KwotyPozycji {
  const stawka = stawkaVat(p.vat);

  if (p.wartosc_brutto !== undefined) {
    const brutto_gr = gr(p.wartosc_brutto);
    const netto_gr = Math.round(brutto_gr / (1 + stawka / 100));
    return { netto_gr, vat_gr: brutto_gr - netto_gr, brutto_gr };
  }

  const cena_gr = gr(p.cena_netto ?? 0);
  const netto_gr = Math.round(cena_gr * p.ilosc * (1 - (p.rabat ?? 0) / 100));
  const vat_gr = Math.round((netto_gr * stawka) / 100);
  return { netto_gr, vat_gr, brutto_gr: netto_gr + vat_gr };
}

export type Podglad = {
  typ_dokumentu: string;
  data_wystawienia: string;
  data_sprzedazy: string;
  termin_platnosci_data: string;
  waluta: string;
  rodzaj_platnosci: string;
  nabywca: Record<string, string>;
  pozycje: Record<string, string>[];
  suma_netto: string;
  suma_vat: string;
  suma_brutto: string;
  platnosc: {
    status: "nieopłacona" | "opłacona" | "częściowo opłacona";
    kwota_oplacona: string;
    data_oplacenia: string;
  };
  nr_zamowienia: string;
  data_zamowienia: string;
  uwaga: string;
};

/** Uzupelnia domyslne daty - reszta domyslnych wartosci pochodzi z schematu Zod. */
function daty(input: FakturaInput): { wystawienia: string; sprzedazy: string; termin: string } {
  const wystawienia = input.data_wystawienia ?? new Date().toISOString().slice(0, 10);
  return {
    wystawienia,
    sprzedazy: input.data_sprzedazy ?? wystawienia,
    termin: input.termin_platnosci_data ?? addDays(wystawienia, input.termin_dni),
  };
}

function sumaBruttoGr(input: FakturaInput): number {
  return input.pozycje.map(policzPozycje).reduce((acc, k) => acc + k.brutto_gr, 0);
}

type Oplacenie = { kwota_gr: number; data: string } | undefined;

/** Kwota i data wplaty - undefined, gdy faktura ma zostac nieoplacona. */
function oplacenie(input: FakturaInput): Oplacenie {
  const kwota_gr = input.oplacona
    ? sumaBruttoGr(input)
    : input.kwota_oplacona !== undefined
      ? gr(input.kwota_oplacona)
      : undefined;
  if (kwota_gr === undefined) return undefined;
  return { kwota_gr, data: input.data_oplacenia ?? daty(input).sprzedazy };
}

/** Czy wystawiona faktura powinna miec status "oplacona" (kod 2 w API). */
export function oczekiwanaOplacona(input: FakturaInput): boolean {
  const o = oplacenie(input);
  return o !== undefined && o.kwota_gr >= sumaBruttoGr(input);
}

export function buildPodglad(input: FakturaInput): Podglad {
  const d = daty(input);
  const kwoty = input.pozycje.map(policzPozycje);
  const suma = kwoty.reduce(
    (acc, k) => ({
      netto_gr: acc.netto_gr + k.netto_gr,
      vat_gr: acc.vat_gr + k.vat_gr,
      brutto_gr: acc.brutto_gr + k.brutto_gr,
    }),
    { netto_gr: 0, vat_gr: 0, brutto_gr: 0 },
  );

  return {
    typ_dokumentu: "Faktura VAT",
    data_wystawienia: d.wystawienia,
    data_sprzedazy: d.sprzedazy,
    termin_platnosci_data: d.termin,
    waluta: input.waluta,
    rodzaj_platnosci: input.rodzaj_platnosci,
    nabywca: {
      nazwa: input.nabywca.nazwa,
      nip: input.nabywca.nip ?? "",
      adres: [input.nabywca.ulica_i_numer, input.nabywca.kod_pocztowy, input.nabywca.miejscowosc]
        .filter(Boolean)
        .join(", "),
      kraj: input.nabywca.kraj,
    },
    pozycje: input.pozycje.map((p, i) => ({
      nazwa: p.nazwa,
      ilosc: String(p.ilosc),
      jm: p.jm,
      vat: String(p.vat),
      rabat: p.rabat !== undefined ? `${p.rabat}%` : "",
      netto: zl(kwoty[i].netto_gr),
      brutto: zl(kwoty[i].brutto_gr),
    })),
    suma_netto: zl(suma.netto_gr),
    suma_vat: zl(suma.vat_gr),
    suma_brutto: zl(suma.brutto_gr),
    platnosc: platnoscPodglad(input, suma.brutto_gr),
    nr_zamowienia: input.nr_zamowienia ?? "",
    data_zamowienia: input.data_zamowienia ?? "",
    uwaga: "Kwoty wyliczone lokalnie do podglądu; ostateczne wartości nalicza FakturaXL przy wystawieniu.",
  };
}

function platnoscPodglad(input: FakturaInput, brutto_gr: number): Podglad["platnosc"] {
  const o = oplacenie(input);
  if (o === undefined) return { status: "nieopłacona", kwota_oplacona: "0.00", data_oplacenia: "" };
  return {
    status: o.kwota_gr >= brutto_gr ? "opłacona" : "częściowo opłacona",
    kwota_oplacona: zl(o.kwota_gr),
    data_oplacenia: o.data,
  };
}

/** Mapuje wejscie narzedzia na strukture XML endpointu dokument_dodaj.php. */
export function buildXmlPayload(input: FakturaInput, apiToken: string): XmlParams {
  const d = daty(input);
  const o = oplacenie(input);

  return {
    api_token: apiToken,
    typ_faktury: 0,
    rodzaj_faktury_koszty: 1,
    obliczaj_wartosc_faktury_od: 0,
    data_wystawienia: d.wystawienia,
    data_sprzedazy: d.sprzedazy,
    termin_platnosci_data: d.termin,
    waluta: input.waluta,
    rodzaj_platnosci: input.rodzaj_platnosci,
    uwagi: input.uwagi,
    miejsce_wystawienia: input.miejsce_wystawienia,
    id_dzialy_firmy: input.id_dzialy_firmy,
    // Pola z przykladu dokument_dodaj.php w dokumentacji FakturaXL.
    kwota_oplacona: o ? zl(o.kwota_gr) : undefined,
    data_oplacenia: o?.data,
    nr_zamowienia: input.nr_zamowienia,
    data_zamowienia: input.data_zamowienia,
    imie_nazwisko_wystawcy: input.imie_nazwisko_wystawcy,
    nabywca: {
      firma_lub_osoba_prywatna: input.nabywca.osoba_prywatna ? 1 : 0,
      nazwa: input.nabywca.nazwa,
      nip: input.nabywca.nip,
      ulica_i_numer: input.nabywca.ulica_i_numer,
      kod_pocztowy: input.nabywca.kod_pocztowy,
      miejscowosc: input.nabywca.miejscowosc,
      kraj: input.nabywca.kraj,
      email: input.nabywca.email,
    },
    faktura_pozycje: input.pozycje.map((p) => ({
      nazwa: p.nazwa,
      ilosc: p.ilosc,
      jm: p.jm,
      vat: p.vat,
      pkwiu: p.pkwiu,
      cena_netto: p.cena_netto,
      rabat: p.rabat,
      wartosc_brutto: p.wartosc_brutto,
    })),
  };
}
