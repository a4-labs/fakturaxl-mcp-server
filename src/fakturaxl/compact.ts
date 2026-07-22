export type Doc = Record<string, unknown>;

const STATUS_LABEL: Record<string, string> = {
  "0": "Nieopłacona",
  "1": "Częściowo opłacona",
  "2": "Opłacona",
};

const RODZAJ_LABEL: Record<string, string> = {
  "1": "przychód",
  "2": "koszt",
};

function s(v: unknown): string {
  return v === undefined || v === null ? "" : String(v);
}

/** Parsuje wartosc pieniezna (string ze zrodla) do liczby. */
function money(v: unknown): number {
  const n = Number(s(v).replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Compact dokument - tylko pola istotne dla agenta (reszta przez pobierz_dokument). */
export function compactDoc(d: Doc): Doc {
  return {
    id: s(d.id),
    numer_faktury: s(d.numer_faktury),
    typ: s(d.typ_faktury_str),
    rodzaj: RODZAJ_LABEL[s(d.rodzaj_faktury_koszty)] ?? s(d.rodzaj_faktury_koszty),
    data_wystawienia: s(d.data_wystawienia),
    data_sprzedazy: s(d.data_sprzedazy),
    klient: s(d.nazwa_skrocona_odbiorcy),
    klient_id: s(d.klient_id),
    netto: money(d.wartosc_netto),
    vat: money(d.wartosc_vat),
    brutto: money(d.wartosc_brutto),
    waluta: s(d.waluta_str),
    status: STATUS_LABEL[s(d.status)] ?? s(d.status),
    data_oplacenia: s(d.data_oplacenia),
    kwota_oplacona: money(d.kwota_oplacona),
  };
}

export function compactClient(c: Doc): Doc {
  return {
    id: s(c.id),
    nazwa: s(c.nazwa),
    nazwa_skrocona: s(c.nazwa_skrocona),
    nip: s(c.nip),
    miejscowosc: s(c.miejscowosc),
    kod_pocztowy: s(c.kod_pocztowy),
    email: s(c.email),
    telefon: s(c.telefon),
  };
}

export function compactProduct(p: Doc): Doc {
  return {
    id: s(p.id),
    nazwa: s(p.nazwa),
    kod_produktu: s(p.kod_produktu),
    cena_netto: money(p.cena_sprzedazy_netto),
    cena_brutto: money(p.cena_sprzedazy_brutto),
    vat: s(p.vat),
    jm: s(p.jm),
    kod_kreskowy: s(p.kod_kreskowy),
  };
}

export type DocumentsSummary = {
  liczba: number;
  wg_waluty: Record<string, { netto: number; vat: number; brutto: number; oplacono: number }>;
  wg_statusu: Record<string, number>;
  wg_rodzaju: Record<string, number>;
};

/** Agregacja dokumentow: liczba + sumy per waluta + rozklad statusow/rodzajow. */
export function summarizeDocuments(docs: Doc[]): DocumentsSummary {
  const wg_waluty: DocumentsSummary["wg_waluty"] = {};
  const wg_statusu: Record<string, number> = {};
  const wg_rodzaju: Record<string, number> = {};

  for (const d of docs) {
    const waluta = s(d.waluta_str) || "PLN";
    const bucket = (wg_waluty[waluta] ??= { netto: 0, vat: 0, brutto: 0, oplacono: 0 });
    bucket.netto = round2(bucket.netto + money(d.wartosc_netto));
    bucket.vat = round2(bucket.vat + money(d.wartosc_vat));
    bucket.brutto = round2(bucket.brutto + money(d.wartosc_brutto));
    bucket.oplacono = round2(bucket.oplacono + money(d.kwota_oplacona));

    const status = STATUS_LABEL[s(d.status)] ?? (s(d.status) || "nieznany");
    wg_statusu[status] = (wg_statusu[status] ?? 0) + 1;

    const rodzaj = RODZAJ_LABEL[s(d.rodzaj_faktury_koszty)] ?? "nieokreślony";
    wg_rodzaju[rodzaj] = (wg_rodzaju[rodzaj] ?? 0) + 1;
  }

  return { liczba: docs.length, wg_waluty, wg_statusu, wg_rodzaju };
}
