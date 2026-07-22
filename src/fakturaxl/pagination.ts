import { config } from "../config.js";
import { logger } from "../logger.js";
import { fakturaXlCall, type XmlParams } from "./client.js";

/** Normalizuje wartosc z parsera XML do tablicy (pojedynczy element -> [element]). */
export function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

type Paginacja = {
  strona?: number | string;
  na_stronie?: number | string;
  wszystkie_strony?: number | string;
  wszystkie_wyniki?: number | string;
};

type DokumentyResponse = {
  dokumenty?: Record<string, unknown> & { paginacja?: Paginacja };
};

/**
 * Auto-paginacja: pobiera wszystkie strony danego endpointu (root <dokumenty>)
 * i zwraca polaczona tablice pozycji spod klucza itemKey. Agent nie widzi stron.
 * Kazde wywolanie strony przechodzi przez rate limiter (odstepy per endpoint).
 */
export async function fetchAllPages(
  endpoint: string,
  itemKey: string,
  params: XmlParams = {},
): Promise<unknown[]> {
  const items: unknown[] = [];
  let strona = 1;
  let totalPages = 1;

  do {
    const raw = (await fakturaXlCall(endpoint, {
      ...params,
      strona,
      na_stronie: config.pageSize,
    })) as DokumentyResponse;

    const dokumenty = raw?.dokumenty;
    const pageItems = toArray(dokumenty?.[itemKey]);
    items.push(...pageItems);

    const wszystkieStrony = Number(dokumenty?.paginacja?.wszystkie_strony);
    totalPages = Number.isFinite(wszystkieStrony) && wszystkieStrony > 0 ? wszystkieStrony : 1;

    logger.debug("pagination.page", { endpoint, itemKey, strona, totalPages, got: pageItems.length });
    strona += 1;
  } while (strona <= totalPages);

  return items;
}
