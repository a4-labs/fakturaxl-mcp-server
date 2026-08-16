import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { ApiTokenValidationError } from "../../src/auth/provider.js";
import { createOAuthRuntime } from "../../src/auth/runtime.js";

const REDIRECT_URI = "http://localhost:8787/callback";
const PUBLIC_BASE_URL = new URL("https://mcp.example.test");
const RESOURCE_URL = new URL("https://mcp.example.test/mcp");
const REMOTE_CLIENT_REDIRECT_URIS = [
  "https://chatgpt.com/connector/oauth/01234567-89ab-cdef-0123-456789abcdef",
  "https://chatgpt.com/connector_platform_oauth_redirect",
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
] as const;

function hiddenValue(html: string, name: string): string {
  const match = new RegExp(`name="${name}" value="([^"]+)"`).exec(html);
  if (!match?.[1]) throw new Error(`Brak pola ${name}`);
  return match[1];
}

function initializeBody(): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "oauth-test", version: "1.0.0" },
    },
  });
}

describe("OAuth HTTP flow", () => {
  let server: Server;
  let baseUrl: string;
  let directory: string;
  let accessToken: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "fakturaxl-oauth-http-"));
    const validateApiToken = vi.fn(async (apiToken: string) => {
      if (!["valid-fakturaxl-key", "legacy-fakturaxl-key"].includes(apiToken)) {
        throw new ApiTokenValidationError("Nieprawidłowy klucz.");
      }
    });
    const oauth = await createOAuthRuntime({
      publicBaseUrl: PUBLIC_BASE_URL,
      storePath: join(directory, "oauth-store.json"),
      storeKey: Buffer.alloc(32, 5),
      allowedRedirectUris: [REDIRECT_URI],
      validateApiToken,
    });
    const app = createApp({ oauth });
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await rm(directory, { force: true, recursive: true });
  });

  it("publishes authorization and protected-resource metadata", async () => {
    const authorization = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    expect(authorization.status).toBe(200);
    await expect(authorization.json()).resolves.toMatchObject({
      issuer: PUBLIC_BASE_URL.href,
      authorization_endpoint: `${PUBLIC_BASE_URL.href}authorize`,
      registration_endpoint: `${PUBLIC_BASE_URL.href}register`,
      scopes_supported: ["mcp:tools"],
      code_challenge_methods_supported: ["S256"],
    });

    const resource = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`);
    expect(resource.status).toBe(200);
    await expect(resource.json()).resolves.toMatchObject({
      resource: RESOURCE_URL.href,
      authorization_servers: [PUBLIC_BASE_URL.href],
      scopes_supported: ["mcp:tools"],
    });
  });

  it.each(REMOTE_CLIENT_REDIRECT_URIS)("accepts DCR over HTTP for %s", async (redirectUri) => {
    const registration = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    });

    expect(registration.status).toBe(201);
    await expect(registration.json()).resolves.toMatchObject({ redirect_uris: [redirectUri] });
  });

  it("completes Claude DCR when token_endpoint_auth_method is omitted", async () => {
    const redirectUri = "https://claude.ai/api/mcp/auth_callback";
    const registration = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        client_name: "Claude",
      }),
    });

    expect(registration.status).toBe(201);
    const client = (await registration.json()) as {
      client_id: string;
      client_secret: string;
      token_endpoint_auth_method: string;
    };
    expect(client).toMatchObject({ token_endpoint_auth_method: "client_secret_post" });
    expect(client.client_secret).toBeTruthy();

    const verifier = "claude-pkce-verifier-with-more-than-forty-three-characters";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorizeUrl = new URL(`${baseUrl}/authorize`);
    authorizeUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "mcp:tools",
      resource: RESOURCE_URL.href,
    }).toString();
    const authorization = await fetch(authorizeUrl);
    expect(authorization.status).toBe(200);
    const html = await authorization.text();

    const completion = await fetch(`${baseUrl}/oauth/authorize/complete`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        pending_id: hiddenValue(html, "pending_id"),
        csrf_token: hiddenValue(html, "csrf_token"),
        api_key: "valid-fakturaxl-key",
      }),
    });
    expect(completion.status).toBe(302);
    const code = new URL(completion.headers.get("location")!).searchParams.get("code")!;

    const token = await fetch(`${baseUrl}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client.client_id,
        client_secret: client.client_secret,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        resource: RESOURCE_URL.href,
      }),
    });
    expect(token.status).toBe(200);
    await expect(token.json()).resolves.toMatchObject({
      token_type: "Bearer",
      scope: "mcp:tools",
    });
  });

  it("completes DCR, PKCE authorization and token exchange", async () => {
    const registration = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        client_name: "Cursor",
      }),
    });
    expect(registration.status).toBe(201);
    const client = (await registration.json()) as { client_id: string };

    const verifier = "cursor-pkce-verifier-with-more-than-forty-three-characters";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorizeUrl = new URL(`${baseUrl}/authorize`);
    authorizeUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "mcp:tools",
      state: "cursor-state",
      resource: RESOURCE_URL.href,
    }).toString();
    const authorization = await fetch(authorizeUrl);
    expect(authorization.status).toBe(200);
    const html = await authorization.text();

    const completion = await fetch(`${baseUrl}/oauth/authorize/complete`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        pending_id: hiddenValue(html, "pending_id"),
        csrf_token: hiddenValue(html, "csrf_token"),
        api_key: "valid-fakturaxl-key",
      }),
    });
    expect(completion.status).toBe(302);
    const callback = new URL(completion.headers.get("location")!);
    expect(callback.searchParams.get("state")).toBe("cursor-state");

    const token = await fetch(`${baseUrl}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client.client_id,
        code: callback.searchParams.get("code")!,
        code_verifier: verifier,
        redirect_uri: REDIRECT_URI,
        resource: RESOURCE_URL.href,
      }),
    });
    expect(token.status).toBe(200);
    const tokens = (await token.json()) as { access_token: string };
    accessToken = tokens.access_token;
    expect(accessToken).toMatch(/^fxlmcp_at_/);
  });

  it("uses OAuth access tokens for MCP without breaking legacy Bearer", async () => {
    const oauthResponse = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: initializeBody(),
    });
    expect(oauthResponse.status).toBe(200);

    const legacyResponse = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: "Bearer legacy-fakturaxl-key",
        "content-type": "application/json",
      },
      body: initializeBody(),
    });
    expect(legacyResponse.status).toBe(200);
  });

  it("returns an OAuth discovery challenge for missing or expired OAuth credentials", async () => {
    for (const authorization of [undefined, "Bearer fxlmcp_at_invalid", "Bearer cursor-bootstrap-token"]) {
      const response = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          ...(authorization ? { authorization } : {}),
          "content-type": "application/json",
        },
        body: initializeBody(),
      });
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain("resource_metadata=");
    }
  });
});
