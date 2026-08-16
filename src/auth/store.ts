import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

const clientSchema = z
  .object({
    client_id: z.string().min(1),
    redirect_uris: z.array(z.string().min(1)),
    client_secret: z.string().optional(),
    client_id_issued_at: z.number().optional(),
    client_secret_expires_at: z.number().optional(),
    client_name: z.string().optional(),
    grant_types: z.array(z.string()).optional(),
    response_types: z.array(z.string()).optional(),
    token_endpoint_auth_method: z.string().optional(),
    scope: z.string().optional(),
  })
  .loose();

const pendingSchema = z.object({
  clientId: z.string(),
  redirectUri: z.string(),
  codeChallenge: z.string(),
  scopes: z.array(z.string()),
  state: z.string().optional(),
  resource: z.string().optional(),
  csrfHash: z.string(),
  expiresAtMs: z.number(),
});

const grantSchema = z.object({
  id: z.string(),
  clientId: z.string(),
  apiToken: z.string(),
  scopes: z.array(z.string()),
  resource: z.string().optional(),
  createdAtMs: z.number(),
  expiresAtMs: z.number().nullable(),
});

const authorizationCodeSchema = z.object({
  grantId: z.string(),
  clientId: z.string(),
  redirectUri: z.string(),
  codeChallenge: z.string(),
  scopes: z.array(z.string()),
  resource: z.string().optional(),
  expiresAtMs: z.number(),
});

const tokenSchema = z.object({
  grantId: z.string(),
  clientId: z.string(),
  scopes: z.array(z.string()),
  resource: z.string().optional(),
  expiresAtMs: z.number().nullable(),
});

const stateSchema = z.object({
  version: z.literal(1),
  clients: z.record(z.string(), clientSchema),
  pendingAuthorizations: z.record(z.string(), pendingSchema),
  authorizationCodes: z.record(z.string(), authorizationCodeSchema),
  grants: z.record(z.string(), grantSchema),
  accessTokens: z.record(z.string(), tokenSchema),
  refreshTokens: z.record(z.string(), tokenSchema),
});

const envelopeSchema = z.object({
  version: z.literal(1),
  algorithm: z.literal("aes-256-gcm"),
  iv: z.string(),
  authTag: z.string(),
  ciphertext: z.string(),
});

type StoreState = z.infer<typeof stateSchema>;
type PendingRecord = z.infer<typeof pendingSchema>;
type AuthorizationCodeRecord = z.infer<typeof authorizationCodeSchema>;

export type OAuthClientRecord = z.infer<typeof clientSchema>;
export type PendingAuthorization = Omit<PendingRecord, "csrfHash" | "expiresAtMs">;

export interface PendingAuthorizationInput {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  state?: string;
  resource?: string;
}

export interface EncryptedAuthStoreOptions {
  filePath: string;
  encryptionKey: Buffer;
  now?: () => number;
  pendingTtlMs?: number;
  authorizationCodeTtlMs?: number;
  accessTokenTtlMs?: number;
  refreshTokenTtlMs?: number;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn?: number;
}

export interface ResolvedAccessToken {
  apiToken: string;
  clientId: string;
  scopes: string[];
  resource?: string;
  expiresAtMs: number | null;
}

function emptyState(): StoreState {
  return {
    version: 1,
    clients: {},
    pendingAuthorizations: {},
    authorizationCodes: {},
    grants: {},
    accessTokens: {},
    refreshTokens: {},
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function opaqueToken(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

function hashesMatch(value: string, expectedHash: string): boolean {
  const actual = Buffer.from(hash(value), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class EncryptedAuthStore {
  private readonly filePath: string;
  private readonly encryptionKey: Buffer;
  private readonly now: () => number;
  private readonly pendingTtlMs: number;
  private readonly authorizationCodeTtlMs: number;
  private readonly accessTokenTtlMs: number;
  private readonly refreshTokenTtlMs: number;
  private state: StoreState | undefined;
  private initialization: Promise<void> | undefined;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(options: EncryptedAuthStoreOptions) {
    if (options.encryptionKey.length !== 32) {
      throw new Error("OAUTH_STORE_KEY po dekodowaniu musi mieć dokładnie 32 bajty.");
    }
    this.filePath = options.filePath;
    this.encryptionKey = Buffer.from(options.encryptionKey);
    this.now = options.now ?? Date.now;
    this.pendingTtlMs = options.pendingTtlMs ?? 10 * 60 * 1000;
    this.authorizationCodeTtlMs = options.authorizationCodeTtlMs ?? 5 * 60 * 1000;
    this.accessTokenTtlMs = options.accessTokenTtlMs ?? 0;
    this.refreshTokenTtlMs = options.refreshTokenTtlMs ?? 0;
  }

  async initialize(): Promise<void> {
    if (!this.initialization) {
      this.initialization = this.load();
    }
    return this.initialization;
  }

  async saveClient(client: unknown): Promise<void> {
    const parsed = clientSchema.parse(client);
    await this.mutate((state) => {
      state.clients[parsed.client_id] = clone(parsed);
    });
  }

  async getClient(clientId: string): Promise<OAuthClientRecord | undefined> {
    await this.initialize();
    const client = this.requireState().clients[clientId];
    return client ? clone(client) : undefined;
  }

  async createPendingAuthorization(input: PendingAuthorizationInput): Promise<{ id: string; csrfToken: string }> {
    const id = opaqueToken("fxlmcp_pa_");
    const csrfToken = opaqueToken("fxlmcp_csrf_");
    await this.mutate((state) => {
      state.pendingAuthorizations[id] = {
        ...clone(input),
        csrfHash: hash(csrfToken),
        expiresAtMs: this.now() + this.pendingTtlMs,
      };
    });
    return { id, csrfToken };
  }

  async getPendingAuthorization(id: string, csrfToken: string): Promise<PendingAuthorization | undefined> {
    await this.initialize();
    const record = this.requireState().pendingAuthorizations[id];
    if (!record || record.expiresAtMs <= this.now() || !hashesMatch(csrfToken, record.csrfHash)) {
      return undefined;
    }
    const { csrfHash: _csrfHash, expiresAtMs: _expiresAtMs, ...authorization } = record;
    return clone(authorization);
  }

  async consumePendingAuthorization(id: string, csrfToken: string): Promise<PendingAuthorization | undefined> {
    return this.mutate((state) => {
      const record = state.pendingAuthorizations[id];
      if (!record || record.expiresAtMs <= this.now() || !hashesMatch(csrfToken, record.csrfHash)) {
        return undefined;
      }
      delete state.pendingAuthorizations[id];
      const { csrfHash: _csrfHash, expiresAtMs: _expiresAtMs, ...authorization } = record;
      return clone(authorization);
    });
  }

  async issueAuthorizationCode(authorization: PendingAuthorization, apiToken: string): Promise<string> {
    const code = opaqueToken("fxlmcp_ac_");
    await this.mutate((state) => {
      const grantId = randomUUID();
      state.grants[grantId] = {
        id: grantId,
        clientId: authorization.clientId,
        apiToken,
        scopes: clone(authorization.scopes),
        resource: authorization.resource,
        createdAtMs: this.now(),
        expiresAtMs: this.now() + this.authorizationCodeTtlMs,
      };
      state.authorizationCodes[hash(code)] = {
        grantId,
        clientId: authorization.clientId,
        redirectUri: authorization.redirectUri,
        codeChallenge: authorization.codeChallenge,
        scopes: clone(authorization.scopes),
        resource: authorization.resource,
        expiresAtMs: this.now() + this.authorizationCodeTtlMs,
      };
    });
    return code;
  }

  async getAuthorizationCodeChallenge(code: string, clientId: string): Promise<string | undefined> {
    await this.initialize();
    const record = this.requireState().authorizationCodes[hash(code)];
    if (!record || record.clientId !== clientId || record.expiresAtMs <= this.now()) return undefined;
    return record.codeChallenge;
  }

  async consumeAuthorizationCode(
    code: string,
    binding: { clientId: string; redirectUri: string },
  ): Promise<AuthorizationCodeRecord | undefined> {
    return this.mutate((state) => {
      const codeHash = hash(code);
      const record = state.authorizationCodes[codeHash];
      if (!record) return undefined;
      delete state.authorizationCodes[codeHash];
      if (
        record.expiresAtMs <= this.now() ||
        record.clientId !== binding.clientId ||
        record.redirectUri !== binding.redirectUri
      ) {
        return undefined;
      }
      return clone(record);
    });
  }

  async issueTokens(grantId: string): Promise<IssuedTokens> {
    return this.mutate((state) => this.issueTokensInState(state, grantId));
  }

  async rotateRefreshToken(
    refreshToken: string,
    request: { clientId: string; scopes?: string[]; resource?: string },
  ): Promise<IssuedTokens | undefined> {
    return this.mutate((state) => {
      const tokenHash = hash(refreshToken);
      const current = state.refreshTokens[tokenHash];
      if (!current) return undefined;
      delete state.refreshTokens[tokenHash];

      const grant = state.grants[current.grantId];
      const requestedScopes = request.scopes ?? current.scopes;
      const scopesAllowed = requestedScopes.every((scope) => grant?.scopes.includes(scope));
      const resourceMatches = request.resource === undefined || request.resource === grant?.resource;
      if (
        !grant ||
        (current.expiresAtMs !== null && current.expiresAtMs <= this.now()) ||
        current.clientId !== request.clientId ||
        !scopesAllowed ||
        !resourceMatches
      ) {
        return undefined;
      }
      return this.issueTokensInState(state, grant.id, requestedScopes);
    });
  }

  async resolveAccessToken(accessToken: string): Promise<ResolvedAccessToken | undefined> {
    await this.initialize();
    const state = this.requireState();
    const record = state.accessTokens[hash(accessToken)];
    const grant = record ? state.grants[record.grantId] : undefined;
    if (!record || !grant || (record.expiresAtMs !== null && record.expiresAtMs <= this.now())) return undefined;
    return {
      apiToken: grant.apiToken,
      clientId: record.clientId,
      scopes: clone(record.scopes),
      resource: record.resource,
      expiresAtMs: record.expiresAtMs,
    };
  }

  async revokeToken(token: string, clientId: string): Promise<void> {
    await this.mutate((state) => {
      const tokenHash = hash(token);
      if (state.accessTokens[tokenHash]?.clientId === clientId) delete state.accessTokens[tokenHash];
      if (state.refreshTokens[tokenHash]?.clientId === clientId) delete state.refreshTokens[tokenHash];
    });
  }

  private issueTokensInState(state: StoreState, grantId: string, scopes?: string[]): IssuedTokens {
    const grant = state.grants[grantId];
    if (!grant) throw new Error("Grant OAuth nie istnieje.");

    const accessToken = opaqueToken("fxlmcp_at_");
    const refreshToken = opaqueToken("fxlmcp_rt_");
    const effectiveScopes = clone(scopes ?? grant.scopes);
    state.accessTokens[hash(accessToken)] = {
      grantId,
      clientId: grant.clientId,
      scopes: effectiveScopes,
      resource: grant.resource,
      expiresAtMs: this.accessTokenTtlMs > 0 ? this.now() + this.accessTokenTtlMs : null,
    };
    state.refreshTokens[hash(refreshToken)] = {
      grantId,
      clientId: grant.clientId,
      scopes: effectiveScopes,
      resource: grant.resource,
      expiresAtMs: this.refreshTokenTtlMs > 0 ? this.now() + this.refreshTokenTtlMs : null,
    };
    grant.expiresAtMs = this.refreshTokenTtlMs > 0 ? this.now() + this.refreshTokenTtlMs : null;
    return {
      accessToken,
      refreshToken,
      ...(this.accessTokenTtlMs > 0 ? { expiresIn: Math.floor(this.accessTokenTtlMs / 1000) } : {}),
    };
  }

  private async load(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    try {
      const raw = await readFile(this.filePath, "utf8");
      this.state = this.decrypt(raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.state = emptyState();
        return;
      }
      throw error;
    }
  }

  private decrypt(raw: string): StoreState {
    let envelope: z.infer<typeof envelopeSchema>;
    try {
      envelope = envelopeSchema.parse(JSON.parse(raw));
    } catch {
      throw new Error("Nieprawidłowy format magazynu OAuth.");
    }

    try {
      const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey, Buffer.from(envelope.iv, "base64"));
      decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8");
      return stateSchema.parse(JSON.parse(plaintext));
    } catch {
      throw new Error("Nie można odszyfrować magazynu OAuth.");
    }
  }

  private async mutate<T>(operation: (state: StoreState) => T): Promise<T> {
    const run = this.writeTail.then(async () => {
      await this.initialize();
      const next = clone(this.requireState());
      this.pruneExpired(next);
      const result = operation(next);
      this.pruneExpired(next);
      await this.persist(next);
      this.state = next;
      return result;
    });
    this.writeTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async persist(state: StoreState): Promise<void> {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(state), "utf8"), cipher.final()]);
    const envelope = JSON.stringify({
      version: 1,
      algorithm: "aes-256-gcm",
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    });

    const directory = dirname(this.filePath);
    const temporaryPath = `${this.filePath}.tmp.${process.pid}.${randomBytes(8).toString("hex")}`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(envelope, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, this.filePath);
      if (process.platform !== "win32") await chmod(this.filePath, 0o600);
      await this.syncDirectory(directory);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private async syncDirectory(directory: string): Promise<void> {
    if (process.platform === "win32") return;
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private pruneExpired(state: StoreState): void {
    const now = this.now();
    for (const [id, record] of Object.entries(state.pendingAuthorizations)) {
      if (record.expiresAtMs <= now) delete state.pendingAuthorizations[id];
    }
    for (const [codeHash, record] of Object.entries(state.authorizationCodes)) {
      if (record.expiresAtMs <= now) delete state.authorizationCodes[codeHash];
    }
    for (const collection of [state.accessTokens, state.refreshTokens]) {
      for (const [tokenHash, record] of Object.entries(collection)) {
        if (record.expiresAtMs !== null && record.expiresAtMs <= now) delete collection[tokenHash];
      }
    }

    const referencedGrants = new Set([
      ...Object.values(state.authorizationCodes).map((record) => record.grantId),
      ...Object.values(state.accessTokens).map((record) => record.grantId),
      ...Object.values(state.refreshTokens).map((record) => record.grantId),
    ]);
    for (const [grantId, grant] of Object.entries(state.grants)) {
      if (!referencedGrants.has(grantId) && (grant.expiresAtMs === null || grant.expiresAtMs <= now)) {
        delete state.grants[grantId];
      }
    }
  }

  private requireState(): StoreState {
    if (!this.state) throw new Error("Magazyn OAuth nie został zainicjalizowany.");
    return this.state;
  }
}
