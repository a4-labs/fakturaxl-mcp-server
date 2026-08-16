import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiTokenValidationError,
  FakturaXlOAuthProvider,
  type AuthorizationResponse,
} from "../../src/auth/provider.js";
import { EncryptedAuthStore } from "../../src/auth/store.js";

const KEY = Buffer.alloc(32, 3);
const REDIRECT_URI = "http://localhost:8787/callback";
const RESOURCE = new URL("https://mcp.example.com/mcp");
const TRUSTED_REMOTE_REDIRECT_URIS = [
  "https://chatgpt.com/connector/oauth/01234567-89ab-cdef-0123-456789abcdef",
  "https://chatgpt.com/connector_platform_oauth_redirect",
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
] as const;

function responseDouble(): AuthorizationResponse & {
  body?: string;
  statusCode?: number;
  redirectedTo?: string;
} {
  const response = {
    setHeader: vi.fn(),
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    send(body: string) {
      this.body = body;
      return this;
    },
    redirect(statusOrUrl: number | string, maybeUrl?: string) {
      this.statusCode = typeof statusOrUrl === "number" ? statusOrUrl : 302;
      this.redirectedTo = typeof statusOrUrl === "string" ? statusOrUrl : maybeUrl;
      return this;
    },
  };
  return response as AuthorizationResponse & {
    body?: string;
    statusCode?: number;
    redirectedTo?: string;
  };
}

function hiddenValue(html: string, name: string): string {
  const match = new RegExp(`name="${name}" value="([^"]+)"`).exec(html);
  if (!match?.[1]) throw new Error(`Brak pola ${name}`);
  return match[1];
}

describe("FakturaXlOAuthProvider", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
  });

  async function fixture(validateApiToken = vi.fn(async (_apiToken: string) => undefined)) {
    const directory = await mkdtemp(join(tmpdir(), "fakturaxl-provider-"));
    directories.push(directory);
    const store = new EncryptedAuthStore({
      filePath: join(directory, "oauth-store.json"),
      encryptionKey: KEY,
    });
    await store.initialize();
    const provider = new FakturaXlOAuthProvider({
      store,
      resourceUrl: RESOURCE,
      allowedRedirectUris: [REDIRECT_URI],
      validateApiToken,
    });
    const client = await provider.clientsStore.registerClient!({
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "Cursor",
    });
    return { client, provider, store, validateApiToken };
  }

  it("registers public Cursor, ChatGPT and Claude clients with trusted redirects", async () => {
    const { provider } = await fixture();

    for (const redirectUri of TRUSTED_REMOTE_REDIRECT_URIS) {
      await expect(
        provider.clientsStore.registerClient!({
          redirect_uris: [redirectUri],
          token_endpoint_auth_method: "none",
        }),
      ).resolves.toMatchObject({ redirect_uris: [redirectUri] });
    }
  });

  it("rejects untrusted redirects and confidential clients", async () => {
    const { provider } = await fixture();
    const untrustedRedirectUris = [
      "https://attacker.example/callback",
      "https://chatgpt.com.evil.example/connector/oauth/callback-id",
      "https://chatgpt.com/connector/oauth/",
      "https://chatgpt.com/connector/oauth/callback-id/extra",
      "https://chatgpt.com/connector/oauth/callback-id?next=https://attacker.example",
      "https://claude.ai.evil.example/api/mcp/auth_callback",
      "https://claude.ai/api/mcp/auth_callback/extra",
    ];

    for (const redirectUri of untrustedRedirectUris) {
      await expect(
        provider.clientsStore.registerClient!({
          redirect_uris: [redirectUri],
          token_endpoint_auth_method: "none",
        }),
      ).rejects.toThrow(/redirect_uri/i);
    }
    await expect(
      provider.clientsStore.registerClient!({
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: "client_secret_basic",
      }),
    ).rejects.toThrow(/publiczn/i);
  });

  it("allows the trusted OAuth callback origin in the form CSP", async () => {
    const { provider } = await fixture();
    const redirectUri = TRUSTED_REMOTE_REDIRECT_URIS[0];
    const client = await provider.clientsStore.registerClient!({
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
    });
    const response = responseDouble();

    await provider.authorize(
      client,
      {
        codeChallenge: "pkce-challenge",
        redirectUri,
        resource: RESOURCE,
        scopes: ["mcp:tools"],
      },
      response as unknown as Response,
    );

    expect(response.setHeader).toHaveBeenCalledWith(
      "Content-Security-Policy",
      expect.stringContaining("form-action 'self' https://chatgpt.com"),
    );
  });

  it("renders an accessible form and completes an authorization code flow", async () => {
    const { client, provider, validateApiToken } = await fixture();
    const authorizeResponse = responseDouble();

    await provider.authorize(
      client,
      {
        codeChallenge: "pkce-challenge",
        redirectUri: REDIRECT_URI,
        resource: RESOURCE,
        scopes: ["mcp:tools"],
        state: "cursor-state",
      },
      authorizeResponse as unknown as Response,
    );

    expect(authorizeResponse.statusCode).toBe(200);
    expect(authorizeResponse.body).toContain('name="api_key"');
    expect(authorizeResponse.body).toContain('for="api-key"');
    expect(authorizeResponse.body).toContain('name="viewport"');
    const pendingId = hiddenValue(authorizeResponse.body!, "pending_id");
    const csrfToken = hiddenValue(authorizeResponse.body!, "csrf_token");

    const completeResponse = responseDouble();
    await provider.completeAuthorization(
      {
        body: { pending_id: pendingId, csrf_token: csrfToken, api_key: "valid-fakturaxl-key" },
        ip: "127.0.0.1",
      } as Request,
      completeResponse as unknown as Response,
    );

    expect(validateApiToken).toHaveBeenCalledWith("valid-fakturaxl-key");
    const redirect = new URL(completeResponse.redirectedTo!);
    expect(redirect.origin + redirect.pathname).toBe(REDIRECT_URI);
    expect(redirect.searchParams.get("state")).toBe("cursor-state");
    const code = redirect.searchParams.get("code")!;
    await expect(provider.challengeForAuthorizationCode(client, code)).resolves.toBe("pkce-challenge");

    const tokens = await provider.exchangeAuthorizationCode(client, code, "verifier", REDIRECT_URI, RESOURCE);
    expect(tokens).toMatchObject({
      token_type: "Bearer",
      scope: "mcp:tools",
    });
    expect(tokens.expires_in).toBeUndefined();
    expect(tokens.access_token).toMatch(/^fxlmcp_at_/);
    expect(tokens.refresh_token).toMatch(/^fxlmcp_rt_/);
    await expect(provider.verifyAccessToken(tokens.access_token)).resolves.toMatchObject({
      clientId: client.client_id,
      scopes: ["mcp:tools"],
    });
  });

  it("keeps the pending flow available after a safe validation error", async () => {
    const validator = vi.fn(async () => {
      throw new ApiTokenValidationError("Klucz API FakturaXL jest nieprawidłowy.");
    });
    const { client, provider } = await fixture(validator);
    const authorizeResponse = responseDouble();
    await provider.authorize(
      client,
      { codeChallenge: "challenge", redirectUri: REDIRECT_URI, resource: RESOURCE, scopes: ["mcp:tools"] },
      authorizeResponse as unknown as Response,
    );

    const completeResponse = responseDouble();
    await provider.completeAuthorization(
      {
        body: {
          pending_id: hiddenValue(authorizeResponse.body!, "pending_id"),
          csrf_token: hiddenValue(authorizeResponse.body!, "csrf_token"),
          api_key: "invalid-key",
        },
        ip: "127.0.0.1",
      } as Request,
      completeResponse as unknown as Response,
    );

    expect(completeResponse.statusCode).toBe(401);
    expect(completeResponse.body).toContain("Klucz API FakturaXL jest nieprawidłowy.");
    expect(completeResponse.body).not.toContain("invalid-key");
  });

  it("rotates refresh tokens and supports revocation", async () => {
    const { client, provider } = await fixture();
    const response = responseDouble();
    await provider.authorize(
      client,
      { codeChallenge: "challenge", redirectUri: REDIRECT_URI, resource: RESOURCE, scopes: ["mcp:tools"] },
      response as unknown as Response,
    );
    const completed = responseDouble();
    await provider.completeAuthorization(
      {
        body: {
          pending_id: hiddenValue(response.body!, "pending_id"),
          csrf_token: hiddenValue(response.body!, "csrf_token"),
          api_key: "api-key",
        },
        ip: "127.0.0.1",
      } as Request,
      completed as unknown as Response,
    );
    const code = new URL(completed.redirectedTo!).searchParams.get("code")!;
    const first = await provider.exchangeAuthorizationCode(client, code, "verifier", REDIRECT_URI, RESOURCE);

    const rotated = await provider.exchangeRefreshToken(client, first.refresh_token!, ["mcp:tools"], RESOURCE);
    expect(rotated.refresh_token).not.toBe(first.refresh_token);
    await expect(provider.exchangeRefreshToken(client, first.refresh_token!, ["mcp:tools"], RESOURCE)).rejects.toThrow(
      /refresh/i,
    );

    await provider.revokeToken!(client, { token: rotated.access_token, token_type_hint: "access_token" });
    await expect(provider.verifyAccessToken(rotated.access_token)).rejects.toThrow(/access token/i);
  });
});
