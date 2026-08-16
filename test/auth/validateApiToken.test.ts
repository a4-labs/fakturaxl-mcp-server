import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakturaXlError } from "../../src/fakturaxl/client.js";

const { getDepartments } = vi.hoisted(() => ({ getDepartments: vi.fn() }));

vi.mock("../../src/fakturaxl/service.js", () => ({ getDepartments }));

import { ApiTokenValidationError } from "../../src/auth/provider.js";
import { validateFakturaXlApiToken } from "../../src/auth/validateApiToken.js";

describe("validateFakturaXlApiToken", () => {
  beforeEach(() => {
    getDepartments.mockReset();
  });

  it("accepts a key when the read-only endpoint succeeds", async () => {
    getDepartments.mockResolvedValue([]);

    await expect(validateFakturaXlApiToken("valid-key")).resolves.toBeUndefined();
  });

  it("maps FakturaXL auth errors to a safe form error", async () => {
    getDepartments.mockRejectedValue(new FakturaXlError("raw upstream message", "3", "auth"));

    await expect(validateFakturaXlApiToken("invalid-key")).rejects.toBeInstanceOf(ApiTokenValidationError);
  });

  it("preserves network errors for the temporary-unavailable response", async () => {
    const networkError = new FakturaXlError("timeout", undefined, "network");
    getDepartments.mockRejectedValue(networkError);

    await expect(validateFakturaXlApiToken("valid-key")).rejects.toBe(networkError);
  });
});
