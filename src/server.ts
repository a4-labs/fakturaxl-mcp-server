import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerReadOnlyTools } from "./tools/register.js";

/**
 * Buduje instancje serwera MCP dla konkretnego klucza API (per request).
 * Klucz jest domkniety w narzedziach - kazde wywolanie uzywa wlasnego tokenu.
 */
export function buildServer(apiToken: string): McpServer {
  const server = new McpServer({
    name: "fakturaxl-mcp",
    version: "1.0.0",
  });

  registerReadOnlyTools(server, apiToken);
  return server;
}
