import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildPodglad, buildXmlPayload, fakturaSchema, oczekiwanaOplacona, walidujFakture } from "../src/fakturaxl/invoice.js";

const schema = z.object(fakturaSchema);

const baza = {
  nabywca: { nazwa: "Szkoła Testowa", nip: "5862275973" },
  pozycje: [{ nazwa: "Kurs trenera przygotowania motorycznego", vat: "zw", wartosc_brutto: 414 }],
  data_wystawienia: "2026-10-18",
  data_sprzedazy: "2026-10-18",
  rodzaj_platnosci: "BLIK" as const,
};

describe("faktura - płatność i zamówienie", () => {
  it("bez nowych pól zachowuje się jak wcześniej (nieopłacona, brak pól w XML)", () => {
    const input = schema.parse(baza);
    const xml = buildXmlPayload(input, "t");
    expect(xml.kwota_oplacona).toBeUndefined();
    expect(xml.data_oplacenia).toBeUndefined();
    expect(xml.nr_zamowienia).toBeUndefined();
    expect(buildPodglad(input).platnosc.status).toBe("nieopłacona");
    expect(oczekiwanaOplacona(input)).toBe(false);
  });

  it("oplacona=true wpisuje kwotę brutto i domyślnie datę sprzedaży", () => {
    const input = schema.parse({ ...baza, oplacona: true, nr_zamowienia: "38129", data_zamowienia: "2026-10-18" });
    const xml = buildXmlPayload(input, "t");
    expect(xml.kwota_oplacona).toBe("414.00");
    expect(xml.data_oplacenia).toBe("2026-10-18");
    expect(xml.nr_zamowienia).toBe("38129");
    expect(xml.data_zamowienia).toBe("2026-10-18");
    const p = buildPodglad(input);
    expect(p.platnosc).toEqual({ status: "opłacona", kwota_oplacona: "414.00", data_oplacenia: "2026-10-18" });
    expect(p.nr_zamowienia).toBe("38129");
    expect(oczekiwanaOplacona(input)).toBe(true);
  });

  it("kwota_oplacona mniejsza od brutto = częściowo opłacona", () => {
    const input = schema.parse({ ...baza, kwota_oplacona: 100, data_oplacenia: "2026-10-17" });
    expect(buildPodglad(input).platnosc).toEqual({
      status: "częściowo opłacona",
      kwota_oplacona: "100.00",
      data_oplacenia: "2026-10-17",
    });
    expect(oczekiwanaOplacona(input)).toBe(false);
  });

  it("odrzuca sprzeczne i niepełne dane", () => {
    expect(() => walidujFakture(schema.parse({ ...baza, oplacona: true, kwota_oplacona: 10 }))).toThrow();
    expect(() => walidujFakture(schema.parse({ ...baza, data_oplacenia: "2026-10-18" }))).toThrow();
    expect(() => schema.parse({ ...baza, data_zamowienia: "18.10.2026" })).toThrow();
  });
});
