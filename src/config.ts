import "dotenv/config";

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export const config = {
  port: num(process.env.PORT, 3000),
  fakturaXlBaseUrl: (process.env.FAKTURAXL_BASE_URL ?? "https://program.fakturaxl.pl/api").replace(/\/+$/, ""),
  fakturaXlTimeoutMs: num(process.env.FAKTURAXL_TIMEOUT_MS, 30000),
  logLevel: (process.env.LOG_LEVEL as LogLevel) ?? "info",
  logToFile: bool(process.env.LOG_TO_FILE, true),

  // Warstwa praktyczna dla agenta:
  // domyslna liczba wierszy zwracanych z list (reszta dostepna przez has_more/limit)
  defaultListLimit: num(process.env.DEFAULT_LIST_LIMIT, 50),
  // twardy gorny limit wierszy, ktore w ogole zwracamy do agenta
  maxListLimit: num(process.env.MAX_LIST_LIMIT, 500),
  // maksymalny zakres dat dla auto-chunkingu (w miesiacach); powyzej -> przycinamy + ostrzezenie
  maxRangeMonths: num(process.env.MAX_RANGE_MONTHS, 24),
  // TTL cache list slownikowych (klienci/produkty/magazyny/dzialy) w ms
  cacheTtlMs: num(process.env.CACHE_TTL_MS, 5 * 60 * 1000),
  // liczba wynikow na strone przy auto-paginacji (max FakturaXL = 500)
  pageSize: num(process.env.PAGE_SIZE, 500),
  // liczba prob przy kodzie 2 (rate limit) zanim zwrocimy blad
  rateLimitRetries: num(process.env.RATE_LIMIT_RETRIES, 5),
} as const;
