import { logger } from "../logger.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Minimalne odstepy miedzy wywolaniami per endpoint (z dokumentacji FakturaXL,
 * sekcja "Jak czesto mozna odpytac API"). Wartosci w ms.
 *
 * Zweryfikowane empirycznie na produkcyjnym API: odstep jest WYMUSZANY (kod 2)
 * i dotyczy calego endpointu, nie pojedynczego zapytania - rozne zakresy dat
 * wyslane szybciej niz co 5s tez dostaja kod 2. Nie da sie tego zrownoleglic.
 */
const ENDPOINT_INTERVALS: Record<string, number> = {
  "dokument_dodaj.php": 2000,
  "lista_dokumentow.php": 5000,
  "lista_produktow.php": 10000,
  "lista_klientow.php": 10000,
  "ilosc_produktow_w_magazynie.php": 10000,
};
const DEFAULT_INTERVAL = 1000;

/** Po tym czasie bezczynnosci wpis kolejki jest usuwany (mapa nie rosnie bez konca). */
const IDLE_TTL_MS = 10 * 60 * 1000;

function intervalFor(endpoint: string): number {
  return ENDPOINT_INTERVALS[endpoint] ?? DEFAULT_INTERVAL;
}

type Queue = {
  lastFinished: number;
  tail: Promise<unknown>;
  pending: number;
};

/**
 * Limiter serializuje wywolania i wymusza minimalny odstep w obrebie jednej kolejki.
 *
 * Kolejka jest per (token API + endpoint), bo limit FakturaXL obowiazuje per konto.
 * Dzieki temu agent pracujacy na jednym koncie nie blokuje agentow na innych kontach
 * - wczesniej jedna globalna kolejka powodowala, ze zapytanie o dwa lata dokumentow
 * wstrzymywalo wszystkie inne wywolania w calym procesie.
 */
class RateLimiter {
  private queues = new Map<string, Queue>();

  async run<T>(scope: string, endpoint: string, fn: () => Promise<T>): Promise<T> {
    const interval = intervalFor(endpoint);
    const key = `${scope}|${endpoint}`;
    this.prune();

    const queue = this.queues.get(key) ?? { lastFinished: 0, tail: Promise.resolve(), pending: 0 };
    this.queues.set(key, queue);
    queue.pending += 1;

    const task = queue.tail.catch(() => {}).then(async () => {
      const wait = Math.max(0, queue.lastFinished + interval - Date.now());
      if (wait > 0) {
        logger.debug("ratelimit.wait", { endpoint, waitMs: wait });
        await sleep(wait);
      }
      try {
        return await fn();
      } finally {
        queue.lastFinished = Date.now();
        queue.pending -= 1;
      }
    });

    queue.tail = task.catch(() => {});
    return task;
  }

  /** Czas oczekiwania, ktory zaplaci NASTEPNE wywolanie - potrzebny do budzetu czasu narzedzia. */
  nextWaitMs(scope: string, endpoint: string): number {
    const queue = this.queues.get(`${scope}|${endpoint}`);
    if (!queue) return 0;
    const interval = intervalFor(endpoint);
    return Math.max(0, queue.lastFinished + interval - Date.now()) + queue.pending * interval;
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, queue] of this.queues) {
      if (queue.pending === 0 && now - queue.lastFinished > IDLE_TTL_MS) {
        this.queues.delete(key);
      }
    }
  }
}

export const rateLimiter = new RateLimiter();
export { sleep, intervalFor };
