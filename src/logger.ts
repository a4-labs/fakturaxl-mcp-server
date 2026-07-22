import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { config, type LogLevel } from "./config.js";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const LOG_DIR = join(process.cwd(), "logs");

/**
 * Maskuje sekret (klucz API / token) - zostawia tylko ostatnie 4 znaki.
 * Zgodnie z zasadami projektu logujemy raw request/response, ale token maskujemy.
 */
export function maskSecret(value: string | undefined | null): string {
  if (!value) return "";
  if (value.length <= 4) return "****";
  return `****${value.slice(-4)}`;
}

/** Rekurencyjnie maskuje pola api_token / authorization w obiektach logowanych. */
export function maskDeep<T>(input: T): T {
  if (typeof input === "string") return input as T;
  if (Array.isArray(input)) return input.map((v) => maskDeep(v)) as unknown as T;
  if (input && typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (/api_token|authorization|token/i.test(k) && typeof v === "string") {
        out[k] = maskSecret(v);
      } else {
        out[k] = maskDeep(v);
      }
    }
    return out as T;
  }
  return input;
}

function shouldLog(level: LogLevel): boolean {
  return LEVELS[level] >= LEVELS[config.logLevel];
}

async function writeToFile(line: string): Promise<void> {
  if (!config.logToFile) return;
  try {
    await mkdir(LOG_DIR, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    await appendFile(join(LOG_DIR, `fakturaxl-${day}.log`), line + "\n", "utf8");
  } catch {
    // logowanie do pliku jest best-effort; nie wywracamy aplikacji
  }
}

function emit(level: LogLevel, message: string, meta?: unknown): void {
  if (!shouldLog(level)) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    ...(meta !== undefined ? { meta: maskDeep(meta) } : {}),
  };
  const line = JSON.stringify(entry);
  const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  sink(line);
  void writeToFile(line);
}

export const logger = {
  debug: (message: string, meta?: unknown) => emit("debug", message, meta),
  info: (message: string, meta?: unknown) => emit("info", message, meta),
  warn: (message: string, meta?: unknown) => emit("warn", message, meta),
  error: (message: string, meta?: unknown) => emit("error", message, meta),
};
