import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import type { XmlParams } from "./client.js";
import type { Podglad } from "./invoice.js";

/**
 * Magazyn przygotowanych faktur (dwa kroki: przygotuj -> wystaw).
 *
 * Po co: MCP nie ma UI, w ktorym uzytkownik kliknie "potwierdzam", a wystawienie
 * faktury jest nieodwracalne (numeracja ciagla, zamkniety miesiac = kod 21).
 * Agent musi wiec najpierw pokazac podglad i dopiero z tokenem wystawic dokument.
 *
 * Drugi powod to idempotencja, ktorej API FakturaXL nie ma: klient MCP potrafi
 * powtorzyc wywolanie po timeoucie. Zuzyty draft pamieta wynik, wiec ponowne
 * wystawienie na tym samym tokenie zwraca pierwotny dokument zamiast wystawiac
 * drugi. Stan zyje w pamieci procesu - restart uniewaznia niepotwierdzone drafty.
 */

export type Draft = {
  token: string;
  apiToken: string;
  payload: XmlParams;
  podglad: Podglad;
  utworzono: number;
  wynik?: unknown;
};

const drafts = new Map<string, Draft>();

function prune(): void {
  const now = Date.now();
  for (const [token, draft] of drafts) {
    if (now - draft.utworzono > config.draftTtlMs) drafts.delete(token);
  }
}

export function createDraft(apiToken: string, payload: XmlParams, podglad: Podglad): Draft {
  prune();
  const draft: Draft = { token: randomUUID(), apiToken, payload, podglad, utworzono: Date.now() };
  drafts.set(draft.token, draft);
  return draft;
}

export class DraftError extends Error {}

/**
 * Zwraca draft do wystawienia. Token musi istniec, nie byc przedawniony i nalezec
 * do tego samego klucza API - inaczej jeden klient moglby wystawic faktura na
 * koncie innego.
 */
export function getDraft(token: string, apiToken: string): Draft {
  prune();
  const draft = drafts.get(token);
  if (!draft || draft.apiToken !== apiToken) {
    throw new DraftError(
      "Nieznany lub przedawniony 'token_potwierdzenia'. Wywołaj 'przygotuj_fakture' ponownie " +
        `(token jest ważny ${Math.round(config.draftTtlMs / 60000)} min).`,
    );
  }
  return draft;
}

export function markIssued(draft: Draft, wynik: unknown): void {
  draft.wynik = wynik;
}

export function draftExpiresAt(draft: Draft): string {
  return new Date(draft.utworzono + config.draftTtlMs).toISOString();
}
