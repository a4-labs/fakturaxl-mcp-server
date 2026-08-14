import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config } from "./config.js";
import { registerReadOnlyTools } from "./tools/register.js";
import { registerWriteTools } from "./tools/registerWrite.js";

/**
 * Buduje instancje serwera MCP dla konkretnego klucza API (per request).
 * Klucz jest domkniety w narzedziach - kazde wywolanie uzywa wlasnego tokenu.
 *
 * Narzedzia zapisu sa rejestrowane tylko przy ALLOW_WRITE=true. Bez tej flagi
 * agent w ogole ich nie widzi, wiec domyslne wdrozenie pozostaje read-only.
 */
export function buildServer(apiToken: string): McpServer {
  const server = new McpServer({
    name: "fakturaxl-mcp",
    version: "1.0.0",
  });

  registerReadOnlyTools(server, apiToken);
  if (config.allowWrite) registerWriteTools(server, apiToken);
  return server;
}
