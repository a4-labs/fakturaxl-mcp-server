import { AsyncLocalStorage } from "node:async_hooks";

export type CallContext = {
  /** Liczba zapytan do FakturaXL wykonanych w ramach jednego wywolania narzedzia. */
  apiCalls: number;
  startedAt: number;
};

const storage = new AsyncLocalStorage<CallContext>();

/** Uruchamia wywolanie narzedzia we wlasnym kontekscie (licznik zapytan + czas startu). */
export function runInCallContext<T>(fn: (ctx: CallContext) => Promise<T>): Promise<T> {
  const ctx: CallContext = { apiCalls: 0, startedAt: Date.now() };
  return storage.run(ctx, () => fn(ctx));
}

/** Zwieksza licznik zapytan do API biezacego wywolania (jesli istnieje kontekst). */
export function countApiCall(): void {
  const ctx = storage.getStore();
  if (ctx) ctx.apiCalls += 1;
}

export function currentCallContext(): CallContext | undefined {
  return storage.getStore();
}
