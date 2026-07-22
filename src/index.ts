import express, { type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config } from "./config.js";
import { logger, maskSecret } from "./logger.js";
import { buildServer } from "./server.js";

/** Wyciaga klucz API FakturaXL z naglowka Authorization: Bearer <klucz>. */
function extractApiToken(req: Request): string | undefined {
  const header = req.headers["authorization"];
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim();
}

function unauthorized(res: Response): void {
  res.status(401).json({
    jsonrpc: "2.0",
    error: { code: -32001, message: "Brak nagłówka Authorization: Bearer <klucz FakturaXL>" },
    id: null,
  });
}

function methodNotAllowed(_req: Request, res: Response): void {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Metoda niedozwolona. Serwer działa w trybie stateless (tylko POST /mcp)." },
    id: null,
  });
}

const app = express();
app.use(express.json({ limit: "4mb" }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok", name: "fakturaxl-mcp", mode: "read-only" });
});

app.post("/mcp", async (req: Request, res: Response) => {
  const apiToken = extractApiToken(req);
  if (!apiToken) {
    logger.warn("mcp.unauthorized", { ip: req.ip });
    return unauthorized(res);
  }

  const server = buildServer(apiToken);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    logger.debug("mcp.request_handled", { token: maskSecret(apiToken) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("mcp.handler_error", { error: message });
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: `Błąd wewnętrzny serwera: ${message}` },
        id: null,
      });
    }
  }
});

// Streamable HTTP w trybie stateless nie obsluguje GET (SSE) ani DELETE.
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

// Obsluga bledow (np. nieprawidlowy JSON w body) - zwracamy czysty JSON-RPC
// zamiast domyslnej strony HTML ze stack trace (wyciek sciezek serwera).
app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (!err) return next();
  const message = err instanceof Error ? err.message : String(err);
  logger.warn("http.bad_request", { error: message });
  if (!res.headersSent) {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32700, message: "Nieprawidłowe żądanie (parse error)" },
      id: null,
    });
  }
});

app.listen(config.port, () => {
  logger.info("server.started", {
    port: config.port,
    endpoint: `/mcp`,
    baseUrl: config.fakturaXlBaseUrl,
  });
});
