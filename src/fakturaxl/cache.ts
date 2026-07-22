import { config } from "../config.js";

type Entry<T> = { value: T; expiresAt: number };

/**
 * Prosty cache w pamieci z TTL. Uzywany dla list slownikowych
 * (klienci/produkty/magazyny/dzialy), aby przyspieszyc filtrowanie po nazwie/NIP
 * i ograniczyc liczbe wywolan do FakturaXL (istotne przy limitach co 10s).
 *
 * Klucz zawiera token API, wiec dane roznych kont sa odseparowane.
 */
class TtlCache {
  private store = new Map<string, Entry<unknown>>();

  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number = config.cacheTtlMs): void {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  /** Pobiera z cache lub wykonuje loader i zapisuje wynik. */
  async getOrLoad<T>(key: string, loader: () => Promise<T>, ttlMs: number = config.cacheTtlMs): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== undefined) return cached;
    const value = await loader();
    this.set(key, value, ttlMs);
    return value;
  }
}

export const cache = new TtlCache();
