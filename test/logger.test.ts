import { describe, expect, it } from "vitest";
import { maskDeep } from "../src/logger.js";

describe("maskDeep", () => {
  it("masks FakturaXL and OAuth secret fields recursively", () => {
    const result = maskDeep({
      apiKey: "fakturaxl-secret",
      nested: {
        access_token: "access-secret",
        refreshToken: "refresh-secret",
        client_secret: "client-secret",
        code_verifier: "verifier-secret",
        csrf_token: "csrf-secret",
      },
      ordinaryCode: "3",
    });

    expect(result).toEqual({
      apiKey: "****cret",
      nested: {
        access_token: "****cret",
        refreshToken: "****cret",
        client_secret: "****cret",
        code_verifier: "****cret",
        csrf_token: "****cret",
      },
      ordinaryCode: "3",
    });
  });
});
