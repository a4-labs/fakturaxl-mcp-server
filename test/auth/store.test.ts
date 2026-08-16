import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EncryptedAuthStore } from "../../src/auth/store.js";

const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 9);

describe("EncryptedAuthStore", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
  });

  async function fixture(
    now: () => number = Date.now,
    ttl: { accessTokenTtlMs?: number; refreshTokenTtlMs?: number } = {},
  ): Promise<{
    directory: string;
    filePath: string;
    store: EncryptedAuthStore;
  }> {
    const directory = await mkdtemp(join(tmpdir(), "fakturaxl-auth-"));
    directories.push(directory);
    const filePath = join(directory, "oauth-store.json");
    const store = new EncryptedAuthStore({ filePath, encryptionKey: KEY, now, ...ttl });
    await store.initialize();
    return { directory, filePath, store };
  }

  async function createGrant(store: EncryptedAuthStore): Promise<{
    accessToken: string;
    refreshToken: string;
    authorizationCode: string;
  }> {
    const pending = await store.createPendingAuthorization({
      clientId: "cursor-desktop",
      redirectUri: "http://localhost:8787/callback",
      codeChallenge: "challenge",
      scopes: ["mcp:tools"],
      state: "cursor-state",
      resource: "https://mcp.example.com/mcp",
    });
    const authorization = await store.consumePendingAuthorization(pending.id, pending.csrfToken);
    expect(authorization).toBeDefined();

    const authorizationCode = await store.issueAuthorizationCode(authorization!, "secret-fakturaxl-key");
    const exchanged = await store.consumeAuthorizationCode(authorizationCode, {
      clientId: "cursor-desktop",
      redirectUri: "http://localhost:8787/callback",
    });
    expect(exchanged).toBeDefined();

    const tokens = await store.issueTokens(exchanged!.grantId);
    return { ...tokens, authorizationCode };
  }

  it("encrypts the complete document and persists grants across restart", async () => {
    const { filePath, store } = await fixture();
    const tokens = await createGrant(store);

    const rawFile = await readFile(filePath, "utf8");
    expect(rawFile).not.toContain("secret-fakturaxl-key");
    expect(rawFile).not.toContain(tokens.accessToken);
    expect(rawFile).not.toContain(tokens.refreshToken);

    const restarted = new EncryptedAuthStore({ filePath, encryptionKey: KEY });
    await restarted.initialize();
    await expect(restarted.resolveAccessToken(tokens.accessToken)).resolves.toMatchObject({
      apiToken: "secret-fakturaxl-key",
      clientId: "cursor-desktop",
      scopes: ["mcp:tools"],
    });
  });

  it("rejects a wrong encryption key and corrupted ciphertext", async () => {
    const { filePath, store } = await fixture();
    await createGrant(store);

    const wrongKeyStore = new EncryptedAuthStore({ filePath, encryptionKey: OTHER_KEY });
    await expect(wrongKeyStore.initialize()).rejects.toThrow(/odszyfrować/i);

    await writeFile(filePath, '{"version":1,"ciphertext":"broken"}', "utf8");
    const corruptedStore = new EncryptedAuthStore({ filePath, encryptionKey: KEY });
    await expect(corruptedStore.initialize()).rejects.toThrow(/magazyn/i);
  });

  it("consumes pending requests and authorization codes only once", async () => {
    const { store } = await fixture();
    const pending = await store.createPendingAuthorization({
      clientId: "cursor-desktop",
      redirectUri: "http://localhost:8787/callback",
      codeChallenge: "challenge",
      scopes: ["mcp:tools"],
    });

    const authorization = await store.consumePendingAuthorization(pending.id, pending.csrfToken);
    await expect(store.consumePendingAuthorization(pending.id, pending.csrfToken)).resolves.toBeUndefined();

    const code = await store.issueAuthorizationCode(authorization!, "api-key");
    const exchange = { clientId: "cursor-desktop", redirectUri: "http://localhost:8787/callback" };
    await expect(store.consumeAuthorizationCode(code, exchange)).resolves.toBeDefined();
    await expect(store.consumeAuthorizationCode(code, exchange)).resolves.toBeUndefined();
  });

  it("rotates refresh tokens and revokes the previous token", async () => {
    const { store } = await fixture();
    const first = await createGrant(store);

    const rotated = await store.rotateRefreshToken(first.refreshToken, { clientId: "cursor-desktop" });

    expect(rotated).toBeDefined();
    expect(rotated!.refreshToken).not.toBe(first.refreshToken);
    await expect(
      store.rotateRefreshToken(first.refreshToken, { clientId: "cursor-desktop" }),
    ).resolves.toBeUndefined();
    await expect(store.resolveAccessToken(rotated!.accessToken)).resolves.toMatchObject({
      apiToken: "secret-fakturaxl-key",
    });
  });

  it("expires access and refresh tokens", async () => {
    let now = Date.parse("2026-08-16T10:00:00.000Z");
    const { store } = await fixture(() => now, {
      accessTokenTtlMs: 60 * 60 * 1000,
      refreshTokenTtlMs: 30 * 24 * 60 * 60 * 1000,
    });
    const tokens = await createGrant(store);

    now += 60 * 60 * 1000 + 1;
    await expect(store.resolveAccessToken(tokens.accessToken)).resolves.toBeUndefined();

    now += 30 * 24 * 60 * 60 * 1000;
    await expect(store.rotateRefreshToken(tokens.refreshToken, { clientId: "cursor-desktop" })).resolves.toBeUndefined();
  });

  it("keeps access and refresh tokens valid indefinitely by default", async () => {
    let now = Date.parse("2026-08-16T10:00:00.000Z");
    const { store } = await fixture(() => now);
    const tokens = await createGrant(store);

    now += 20 * 365 * 24 * 60 * 60 * 1000;
    await expect(store.resolveAccessToken(tokens.accessToken)).resolves.toMatchObject({
      apiToken: "secret-fakturaxl-key",
      expiresAtMs: null,
    });
    await expect(store.rotateRefreshToken(tokens.refreshToken, { clientId: "cursor-desktop" })).resolves.toBeDefined();
  });

  it("leaves no temporary files after an atomic write", async () => {
    const { directory, store } = await fixture();
    await store.saveClient({
      client_id: "cursor-desktop",
      redirect_uris: ["http://localhost:8787/callback"],
      token_endpoint_auth_method: "none",
    });

    expect(await readdir(directory)).toEqual(["oauth-store.json"]);
  });
});
