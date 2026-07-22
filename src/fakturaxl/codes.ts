/**
 * Mapa kodow zwracanych przez API FakturaXL (sekcja "Zwracane kody" w dokumentacji).
 * Uzywana do czytelnego opisu bledow/statusow w odpowiedziach narzedzi.
 */
export const FAKTURAXL_CODES: Record<string, string> = {
  "1": "Dokument został poprawnie dodany",
  "2": "Przekroczono dozwoloną liczbę zapytań w określonym czasie. Spróbuj ponownie później.",
  "3": "Nie istnieje taki api_token",
  "4": "Nie istnieje dokument o takim ID",
  "5": "Dokument został poprawnie odczytany",
  "6": "Błędny typ dokumentu",
  "7": "Dokument o takim numerze już istnieje",
  "8": "Nie istnieje taki id_dzialy_firmy",
  "13": "Data musi mieć postać yyyy-mm-dd",
  "14": "Błędny status",
  "24": "Nieprawidłowe pole magazyn_id",
  "28": "Maksymalny zakres dat do 31 dni",
  "42": "Nieprawidłowe wykorzystanie API - prosimy o kontakt z pomoc@fakturaxl.pl",
  "68": "Nieprawidłowy format daty",
  "69": "Prosimy o aktualizację wtyczki do nowej wersji",
  "70": "Klucz API został zablokowany - prosimy o kontakt z biurem obsługi klienta",
  "73": "Usługa chwilowo niedostępna",
  "900": "Trwają prace konserwacyjne, zapraszamy za kilka minut.",
};

/** Kody oznaczajace poprawny odczyt (nie traktujemy ich jak blad). */
export const SUCCESS_READ_CODES = new Set(["1", "5"]);

/** Kody oznaczajace blad autoryzacji (nieprawidlowy / zablokowany klucz). */
export const AUTH_ERROR_CODES = new Set(["3", "70"]);

export function describeCode(code: string | number | undefined): string | undefined {
  if (code === undefined || code === null) return undefined;
  return FAKTURAXL_CODES[String(code)];
}
