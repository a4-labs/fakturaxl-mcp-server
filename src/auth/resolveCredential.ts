import type { OAuthRuntime } from "./runtime.js";
import { ApiTokenValidationError } from "./provider.js";

export type CredentialResolution =
  | { status: "ok"; apiToken: string; authMethod: "legacy" | "oauth" }
  | { status: "missing" }
  | { status: "invalid_oauth" }
  | { status: "unavailable" };

function extractBearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim();
}

/**
 * Najpierw szuka opaque tokenu OAuth w magazynie. Pozostały Bearer jest legacy
 * wyłącznie po pozytywnej walidacji w FakturaXL, więc obcy token uruchamia discovery.
 */
export async function resolveCredential(
  authorizationHeader: string | undefined,
  oauth: OAuthRuntime | undefined,
): Promise<CredentialResolution> {
  const bearer = extractBearer(authorizationHeader);
  if (!bearer) return { status: "missing" };

  if (!oauth) {
    return { status: "ok", apiToken: bearer, authMethod: "legacy" };
  }

  const resolved = await oauth.store.resolveAccessToken(bearer);
  if (resolved?.resource === oauth.resourceUrl.href) {
    return { status: "ok", apiToken: resolved.apiToken, authMethod: "oauth" };
  }

  try {
    await oauth.validateApiToken(bearer);
    return { status: "ok", apiToken: bearer, authMethod: "legacy" };
  } catch (error) {
    return { status: error instanceof ApiTokenValidationError ? "invalid_oauth" : "unavailable" };
  }
}
