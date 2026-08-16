import type { RequestHandler } from "express";
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { config } from "../config.js";
import { FakturaXlOAuthProvider } from "./provider.js";
import { EncryptedAuthStore } from "./store.js";
import { validateFakturaXlApiToken } from "./validateApiToken.js";

export interface OAuthRuntime {
  provider: FakturaXlOAuthProvider;
  store: EncryptedAuthStore;
  router: RequestHandler;
  resourceUrl: URL;
  resourceMetadataUrl: string;
  validateApiToken: (apiToken: string) => Promise<void>;
}

export interface CreateOAuthRuntimeOptions {
  publicBaseUrl: URL;
  storePath: string;
  storeKey: Buffer;
  allowedRedirectUris: string[];
  validateApiToken: (apiToken: string) => Promise<void>;
  pendingTtlMs?: number;
  authorizationCodeTtlMs?: number;
  accessTokenTtlMs?: number;
  refreshTokenTtlMs?: number;
  maxAuthorizationAttempts?: number;
  authorizationAttemptWindowMs?: number;
}

function normalizedIssuer(input: URL): URL {
  const issuer = new URL(input);
  if (issuer.search || issuer.hash || issuer.pathname !== "/") {
    throw new Error("PUBLIC_BASE_URL musi wskazywać sam origin bez ścieżki, query i fragmentu.");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(issuer.hostname);
  if (issuer.protocol !== "https:" && !(local && issuer.protocol === "http:")) {
    throw new Error("PUBLIC_BASE_URL musi używać HTTPS; HTTP jest dozwolone wyłącznie dla localhost.");
  }
  return issuer;
}

export async function createOAuthRuntime(options: CreateOAuthRuntimeOptions): Promise<OAuthRuntime> {
  const issuerUrl = normalizedIssuer(options.publicBaseUrl);
  const resourceUrl = new URL("/mcp", issuerUrl);
  const store = new EncryptedAuthStore({
    filePath: options.storePath,
    encryptionKey: options.storeKey,
    pendingTtlMs: options.pendingTtlMs,
    authorizationCodeTtlMs: options.authorizationCodeTtlMs,
    accessTokenTtlMs: options.accessTokenTtlMs,
    refreshTokenTtlMs: options.refreshTokenTtlMs,
  });
  await store.initialize();

  const provider = new FakturaXlOAuthProvider({
    store,
    resourceUrl,
    allowedRedirectUris: options.allowedRedirectUris,
    validateApiToken: options.validateApiToken,
    maxAuthorizationAttempts: options.maxAuthorizationAttempts,
    authorizationAttemptWindowMs: options.authorizationAttemptWindowMs,
  });
  const router = mcpAuthRouter({
    provider,
    issuerUrl,
    baseUrl: issuerUrl,
    resourceServerUrl: resourceUrl,
    scopesSupported: ["mcp:tools"],
    resourceName: "FakturaXL MCP",
    clientRegistrationOptions: {
      clientIdGeneration: false,
    },
  });

  return {
    provider,
    store,
    router,
    resourceUrl,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceUrl),
    validateApiToken: options.validateApiToken,
  };
}

export async function createConfiguredOAuthRuntime(): Promise<OAuthRuntime | undefined> {
  if (!config.oauthEnabled) return undefined;
  if (!config.publicBaseUrl) {
    throw new Error("OAUTH_ENABLED=true wymaga PUBLIC_BASE_URL.");
  }
  if (!config.oauthStoreKey) {
    throw new Error("OAUTH_ENABLED=true wymaga OAUTH_STORE_KEY.");
  }

  const storeKey = Buffer.from(config.oauthStoreKey, "base64");
  if (storeKey.length !== 32) {
    throw new Error("OAUTH_STORE_KEY musi być kluczem 32-bajtowym zakodowanym jako base64.");
  }

  return createOAuthRuntime({
    publicBaseUrl: new URL(config.publicBaseUrl),
    storePath: config.oauthStorePath,
    storeKey,
    allowedRedirectUris: config.oauthAllowedRedirectUris,
    validateApiToken: validateFakturaXlApiToken,
    pendingTtlMs: config.oauthPendingTtlMs,
    authorizationCodeTtlMs: config.oauthAuthorizationCodeTtlMs,
    accessTokenTtlMs: config.oauthAccessTokenTtlMs,
    refreshTokenTtlMs: config.oauthRefreshTokenTtlMs,
    maxAuthorizationAttempts: config.oauthAuthorizationAttempts,
    authorizationAttemptWindowMs: config.oauthAuthorizationAttemptWindowMs,
  });
}
