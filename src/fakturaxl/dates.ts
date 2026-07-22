const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 31;

export type DateRange = { data_od: string; data_do: string };

export type ChunkResult = {
  chunks: DateRange[];
  warnings: string[];
};

function parse(s: string): number {
  if (!DATE_RE.test(s)) {
    throw new Error(`Nieprawidłowy format daty "${s}". Wymagany YYYY-MM-DD.`);
  }
  const [y, m, d] = s.split("-").map(Number);
  const ts = Date.UTC(y, m - 1, d);
  const check = new Date(ts);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) {
    throw new Error(`Nieprawidłowa data "${s}".`);
  }
  return ts;
}

function format(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Odejmuje N miesiecy od daty (UTC). */
function minusMonths(ts: number, months: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - months, d.getUTCDate());
}

/**
 * Dzieli dowolny zakres [data_od, data_do] na okna <= 31 dni (limit FakturaXL).
 * Jesli zakres przekracza maxMonths - przycina data_od i dodaje ostrzezenie.
 * Agent podaje po prostu zakres, reszta dzieje sie wewnetrznie.
 */
export function chunkDateRange(dataOd: string, dataDo: string, maxMonths: number): ChunkResult {
  let od = parse(dataOd);
  const doTs = parse(dataDo);
  const warnings: string[] = [];

  if (od > doTs) {
    throw new Error(`data_od (${dataOd}) jest późniejsza niż data_do (${dataDo}).`);
  }

  const minAllowed = minusMonths(doTs, maxMonths);
  if (od < minAllowed) {
    warnings.push(
      `Zakres przekraczał ${maxMonths} miesięcy - przycięto data_od do ${format(minAllowed)} ` +
        `(pierwotnie ${dataOd}). Zwęź zakres lub zwiększ MAX_RANGE_MONTHS, aby objąć starsze dane.`,
    );
    od = minAllowed;
  }

  const chunks: DateRange[] = [];
  let start = od;
  while (start <= doTs) {
    const end = Math.min(start + (WINDOW_DAYS - 1) * DAY_MS, doTs);
    chunks.push({ data_od: format(start), data_do: format(end) });
    start = end + DAY_MS;
  }

  return { chunks, warnings };
}
