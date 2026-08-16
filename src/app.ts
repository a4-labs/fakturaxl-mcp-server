import express, { type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { resolveCredential } from "./auth/resolveCredential.js";
import type { OAuthRuntime } from "./auth/runtime.js";
import { config } from "./config.js";
import { logger, maskSecret } from "./logger.js";
import { buildServer } from "./server.js";

export interface CreateAppOptions {
  oauth?: OAuthRuntime;
}

function unauthorized(res: Response, oauth: OAuthRuntime | undefined, invalidOAuth = false): void {
  if (oauth) {
    const parameters = [
      `resource_metadata="${oauth.resourceMetadataUrl}"`,
      `scope="mcp:tools"`,
      ...(invalidOAuth ? ['error="invalid_token"'] : []),
    ];
    res.setHeader("WWW-Authenticate", `Bearer ${parameters.join(", ")}`);
  }
  res.status(401).json({
    jsonrpc: "2.0",
    error: {
      code: -32001,
      message: oauth
        ? "Wymagane jest uwierzytelnienie OAuth albo klucz FakturaXL w nagłówku Bearer."
        : "Brak nagłówka Authorization: Bearer <klucz FakturaXL>",
    },
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

/** Nazwa metody / narzędzia z body JSON-RPC - do korelacji logów zadania z wywołaniem narzędzia. */
function describeRequest(body: unknown): { method?: string; tool?: string } {
  const rpc = body as { method?: unknown; params?: { name?: unknown } } | undefined;
  return {
    method: typeof rpc?.method === "string" ? rpc.method : undefined,
    tool: typeof rpc?.params?.name === "string" ? rpc.params.name : undefined,
  };
}

/** Buduje aplikację Express bez otwierania portu, aby można ją było testować. */
export function createApp(options: CreateAppOptions = {}): express.Express {
  const app = express();
  if (config.trustProxyHops > 0) app.set("trust proxy", config.trustProxyHops);
  app.use(express.json({ limit: "4mb" }));

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      name: "fakturaxl-mcp",
      mode: config.allowWrite ? "read-write" : "read-only",
      authentication: options.oauth ? ["legacy-bearer", "oauth"] : ["legacy-bearer"],
    });
  });

  if (options.oauth) {
    app.post(
      "/oauth/authorize/complete",
      express.urlencoded({ extended: false, limit: "8kb" }),
      (req, res) => options.oauth!.provider.completeAuthorization(req, res),
    );
    app.use(options.oauth.router);
  }

  app.post("/mcp", async (req: Request, res: Response) => {
    const credential = await resolveCredential(req.headers.authorization, options.oauth);
    if (credential.status === "unavailable") {
      logger.warn("mcp.auth_validation_unavailable", { ip: req.ip });
      return res.status(503).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Nie udało się zweryfikować poświadczenia. Spróbuj ponownie." },
        id: null,
      });
    }
    if (credential.status !== "ok") {
      logger.warn("mcp.unauthorized", { ip: req.ip });
      return unauthorized(res, options.oauth, credential.status === "invalid_oauth");
    }

    const startedAt = Date.now();
    const request = describeRequest(req.body);
    logger.info("mcp.request", {
      ...request,
      authMethod: credential.authMethod,
      token: maskSecret(credential.apiToken),
    });

    const server = buildServer(credential.apiToken);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    res.on("close", () => {
      if (!res.writableEnded) {
        logger.warn("mcp.client_disconnected", { ...request, durationMs: Date.now() - startedAt });
      }
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      logger.info("mcp.request_handled", { ...request, durationMs: Date.now() - startedAt });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("mcp.handler_error", { ...request, error: message, durationMs: Date.now() - startedAt });
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: `Błąd wewnętrzny serwera: ${message}` },
          id: null,
        });
      }
    }
  });

  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

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

  return app;
}
