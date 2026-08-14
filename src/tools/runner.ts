import { runInCallContext } from "../callContext.js";
import { logger } from "../logger.js";
import { FakturaXlError } from "../fakturaxl/client.js";

export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

export type Payload = Record<string, unknown>;

/**
 * Wykonuje narzedzie w kontekscie pomiarowym i loguje przebieg: argumenty na wejsciu,
 * a na wyjsciu czas trwania, liczbe zapytan do FakturaXL i to, czy zwrocono kursor.
 * Bez tego timeouty po stronie agenta byly w logach niewidoczne.
 */
export async function tool(name: string, args: Payload, fn: () => Promise<Payload>): Promise<ToolResult> {
  return runInCallContext(async (ctx) => {
    logger.info("mcp.tool_call", { tool: name, args });
    try {
      const payload = await fn();
      const text = JSON.stringify(payload, null, 2);
      logger.info("mcp.tool_result", {
        tool: name,
        durationMs: Date.now() - ctx.startedAt,
        apiCalls: ctx.apiCalls,
        responseChars: text.length,
        liczba_zwrocona: payload.liczba_zwrocona,
        liczba_calkowita: payload.liczba_calkowita,
        ukonczono: payload.ukonczono,
        kursor_nastepny: payload.kursor_nastepny,
      });
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      const message = err instanceof FakturaXlError || err instanceof Error ? err.message : String(err);
      logger.error("mcp.tool_error", {
        tool: name,
        durationMs: Date.now() - ctx.startedAt,
        apiCalls: ctx.apiCalls,
        error: message,
      });
      return { isError: true, content: [{ type: "text" as const, text: `Błąd: ${message}` }] };
    }
  });
}
