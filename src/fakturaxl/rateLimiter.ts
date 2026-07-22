import { logger } from "../logger.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Minimalne odstepy miedzy wywolaniami per endpoint (z dokumentacji FakturaXL,
 * sekcja "Jak czesto mozna odpytac API"). Wartosci w ms.
 */
const ENDPOINT_INTERVALS: Record<string, number> = {
  "lista_dokumentow.php": 5000,
  "lista_produktow.php": 10000,
  "lista_klientow.php": 10000,
  "ilosc_produktow_w_magazynie.php": 10000,
};
const DEFAULT_INTERVAL = 1000;

function intervalFor(endpoint: string): number {
  return ENDPOINT_INTERVALS[endpoint] ?? DEFAULT_INTERVAL;
}

/**
 * Globalny (process-wide) limiter. Serializuje wywolania per endpoint i wymusza
 * minimalny odstep miedzy nimi. Dzieki temu agent nigdy nie musi sam obslugiwac
 * limitu "co N sekund" - my go respektujemy natywnie.
 */
class RateLimiter {
  private lastFinished = new Map<string, number>();
  private tail = new Map<string, Promise<unknown>>();

  async run<T>(endpoint: string, fn: () => Promise<T>): Promise<T> {
    const interval = intervalFor(endpoint);
    const prev = this.tail.get(endpoint) ?? Promise.resolve();

    const task = prev.catch(() => {}).then(async () => {
      const now = Date.now();
      const wait = Math.max(0, (this.lastFinished.get(endpoint) ?? 0) + interval - now);
      if (wait > 0) {
        logger.debug("ratelimit.wait", { endpoint, waitMs: wait });
        await sleep(wait);
      }
      try {
        return await fn();
      } finally {
        this.lastFinished.set(endpoint, Date.now());
      }
    });

    this.tail.set(
      endpoint,
      task.catch(() => {}),
    );
    return task as Promise<T>;
  }
}

export const rateLimiter = new RateLimiter();
export { sleep, intervalFor };
