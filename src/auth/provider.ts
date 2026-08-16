import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  OAuthClientInformationFullSchema,
  type OAuthClientInformationFull,
  type OAuthTokenRevocationRequest,
  type OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { z } from "zod";
import { logger } from "../logger.js";
import { authorizationPage, expiredAuthorizationPage, type AuthorizationPage } from "./ui.js";
import { EncryptedAuthStore } from "./store.js";

const SUPPORTED_SCOPE = "mcp:tools";
const CHATGPT_REDIRECT_PREFIX = "/connector/oauth/";
const TRUSTED_REMOTE_REDIRECT_URIS = new Set([
  "https://chatgpt.com/connector_platform_oauth_redirect",
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
]);
const completeAuthorizationSchema = z.object({
  pending_id: z.string().min(1).max(256),
  csrf_token: z.string().min(1).max(256),
  api_key: z.string().trim().min(1).max(512),
});

export interface AuthorizationResponse {
  setHeader(name: string, value: string): unknown;
  status(code: number): AuthorizationResponse;
  send(body: string): unknown;
  redirect(statusOrUrl: number | string, url?: string): unknown;
}

export class ApiTokenValidationError extends Error {
  constructor(readonly safeMessage: string) {
    super(safeMessage);
    this.name = "ApiTokenValidationError";
  }
}

interface FakturaXlOAuthProviderOptions {
  store: EncryptedAuthStore;
  resourceUrl: URL;
  allowedRedirectUris: string[];
  validateApiToken: (apiToken: string) => Promise<void>;
  maxAuthorizationAttempts?: number;
  authorizationAttemptWindowMs?: number;
}

interface AttemptBucket {
  count: number;
  resetsAtMs: number;
}

class AuthorizationAttemptLimiter {
  private readonly buckets = new Map<string, AttemptBucket>();

  constructor(
    private readonly maxAttempts: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  consume(key: string): boolean {
    const now = this.now();
    const current = this.buckets.get(key);
    if (!current || current.resetsAtMs <= now) {
      this.buckets.set(key, { count: 1, resetsAtMs: now + this.windowMs });
      return true;
    }
    if (current.count >= this.maxAttempts) return false;
    current.count += 1;
    return true;
  }
}

function normalizeResource(url: URL): string {
  const normalized = new URL(url);
  normalized.hash = "";
  return normalized.href;
}

function isTrustedRemoteRedirectUri(uri: string): boolean {
  if (TRUSTED_REMOTE_REDIRECT_URIS.has(uri)) return true;

  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }

  if (
    parsed.origin !== "https://chatgpt.com" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !parsed.pathname.startsWith(CHATGPT_REDIRECT_PREFIX)
  ) {
    return false;
  }

  const callbackId = parsed.pathname.slice(CHATGPT_REDIRECT_PREFIX.length);
  return callbackId.length > 0 && !callbackId.includes("/");
}

function sendPage(res: Response, status: number, page: AuthorizationPage): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Security-Policy", page.contentSecurityPolicy);
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.status(status).send(page.html);
}

export class FakturaXlOAuthProvider implements OAuthServerProvider {
  private readonly store: EncryptedAuthStore;
  private readonly resource: string;
  private readonly allowedRedirectUris: ReadonlySet<string>;
  private readonly validateApiToken: (apiToken: string) => Promise<void>;
  private readonly attemptLimiter: AuthorizationAttemptLimiter;
  private readonly registeredClientsStore: OAuthRegisteredClientsStore;

  constructor(options: FakturaXlOAuthProviderOptions) {
    this.store = options.store;
    this.resource = normalizeResource(options.resourceUrl);
    this.allowedRedirectUris = new Set(options.allowedRedirectUris);
    this.validateApiToken = options.validateApiToken;
    this.attemptLimiter = new AuthorizationAttemptLimiter(
      options.maxAuthorizationAttempts ?? 10,
      options.authorizationAttemptWindowMs ?? 15 * 60 * 1000,
    );
    this.registeredClientsStore = {
      getClient: async (clientId) => {
        const client = await this.store.getClient(clientId);
        return client ? OAuthClientInformationFullSchema.parse(client) : undefined;
      },
      registerClient: async (client) => this.registerClient(client),
    };
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return this.registeredClientsStore;
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const scopes = params.scopes?.length ? params.scopes : [SUPPORTED_SCOPE];
    if (scopes.some((scope) => scope !== SUPPORTED_SCOPE)) {
      throw new InvalidScopeError(`Obsługiwany scope: ${SUPPORTED_SCOPE}`);
    }

    const resource = params.resource ? normalizeResource(params.resource) : this.resource;
    if (resource !== this.resource) {
      throw new InvalidTargetError("Nieprawidłowy zasób MCP.");
    }

    const pending = await this.store.createPendingAuthorization({
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      scopes,
      state: params.state,
      resource,
    });
    sendPage(res, 200, authorizationPage({ pendingId: pending.id, csrfToken: pending.csrfToken }));
  }

  async completeAuthorization(req: Request, res: Response): Promise<void> {
    const parsed = completeAuthorizationSchema.safeParse(req.body);
    if (!parsed.success) {
      sendPage(res, 400, expiredAuthorizationPage());
      return;
    }

    const { pending_id: pendingId, csrf_token: csrfToken, api_key: apiToken } = parsed.data;
    const pending = await this.store.getPendingAuthorization(pendingId, csrfToken);
    if (!pending) {
      sendPage(res, 400, expiredAuthorizationPage());
      return;
    }

    if (!this.attemptLimiter.consume(req.ip ?? "unknown")) {
      sendPage(
        res,
        429,
        authorizationPage({
          pendingId,
          csrfToken,
          error: "Przekroczono limit prób. Odczekaj 15 minut i rozpocznij autoryzację ponownie.",
        }),
      );
      return;
    }

    try {
      await this.validateApiToken(apiToken);
    } catch (error) {
      const safeError =
        error instanceof ApiTokenValidationError
          ? error.safeMessage
          : "Nie udało się sprawdzić klucza. Spróbuj ponownie za chwilę.";
      logger.warn("oauth.api_token_validation_failed", {
        ip: req.ip,
        kind: error instanceof ApiTokenValidationError ? "invalid" : "unavailable",
      });
      sendPage(
        res,
        error instanceof ApiTokenValidationError ? 401 : 503,
        authorizationPage({ pendingId, csrfToken, error: safeError }),
      );
      return;
    }

    const consumed = await this.store.consumePendingAuthorization(pendingId, csrfToken);
    if (!consumed) {
      sendPage(res, 400, expiredAuthorizationPage());
      return;
    }

    const code = await this.store.issueAuthorizationCode(consumed, apiToken);
    const redirect = new URL(consumed.redirectUri);
    redirect.searchParams.set("code", code);
    if (consumed.state) redirect.searchParams.set("state", consumed.state);
    res.redirect(302, redirect.href);
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const challenge = await this.store.getAuthorizationCodeChallenge(authorizationCode, client.client_id);
    if (!challenge) throw new InvalidGrantError("Nieprawidłowy lub wygasły kod autoryzacyjny.");
    return challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    if (!redirectUri) throw new InvalidGrantError("Brak redirect_uri.");
    const authorization = await this.store.consumeAuthorizationCode(authorizationCode, {
      clientId: client.client_id,
      redirectUri,
    });
    if (!authorization) throw new InvalidGrantError("Nieprawidłowy lub wykorzystany kod autoryzacyjny.");
    if (resource && normalizeResource(resource) !== authorization.resource) {
      throw new InvalidGrantError("Kod autoryzacyjny wydano dla innego zasobu.");
    }

    const tokens = await this.store.issueTokens(authorization.grantId);
    return {
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      token_type: "Bearer",
      ...(tokens.expiresIn !== undefined ? { expires_in: tokens.expiresIn } : {}),
      scope: authorization.scopes.join(" "),
    };
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const tokens = await this.store.rotateRefreshToken(refreshToken, {
      clientId: client.client_id,
      scopes,
      resource: resource ? normalizeResource(resource) : undefined,
    });
    if (!tokens) throw new InvalidGrantError("Nieprawidłowy, wykorzystany lub wygasły refresh token.");
    return {
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      token_type: "Bearer",
      ...(tokens.expiresIn !== undefined ? { expires_in: tokens.expiresIn } : {}),
      scope: (scopes?.length ? scopes : [SUPPORTED_SCOPE]).join(" "),
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const resolved = await this.store.resolveAccessToken(token);
    if (!resolved) throw new InvalidTokenError("Access token jest nieprawidłowy lub wygasł.");
    return {
      token,
      clientId: resolved.clientId,
      scopes: resolved.scopes,
      ...(resolved.expiresAtMs !== null ? { expiresAt: Math.floor(resolved.expiresAtMs / 1000) } : {}),
      resource: resolved.resource ? new URL(resolved.resource) : undefined,
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    await this.store.revokeToken(request.token, client.client_id);
  }

  private async registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): Promise<OAuthClientInformationFull> {
    if ((client.token_endpoint_auth_method ?? "client_secret_basic") !== "none") {
      throw new InvalidClientMetadataError("Klient MCP musi być klientem publicznym bez client_secret.");
    }
    if (
      client.redirect_uris.length === 0 ||
      client.redirect_uris.some((uri) => !this.allowedRedirectUris.has(uri) && !isTrustedRemoteRedirectUri(uri))
    ) {
      throw new InvalidClientMetadataError("Niedozwolony redirect_uri dla klienta MCP.");
    }
    if (client.grant_types?.some((grant) => !["authorization_code", "refresh_token"].includes(grant))) {
      throw new InvalidClientMetadataError("Obsługiwane granty: authorization_code i refresh_token.");
    }
    if (client.response_types?.some((responseType) => responseType !== "code")) {
      throw new InvalidClientMetadataError("Obsługiwany response_type: code.");
    }

    const registered = OAuthClientInformationFullSchema.parse({
      ...client,
      client_id: randomUUID(),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_secret: undefined,
      client_secret_expires_at: undefined,
    });
    await this.store.saveClient(registered);
    return registered;
  }
}
