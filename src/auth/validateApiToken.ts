import { FakturaXlError } from "../fakturaxl/client.js";
import { getDepartments } from "../fakturaxl/service.js";
import { ApiTokenValidationError } from "./provider.js";

/**
 * Sprawdza klucz przez najmniejszy odczytowy endpoint FakturaXL.
 * Pusty wynik jest poprawny — o ważności świadczy brak kodu błędu autoryzacji.
 */
export async function validateFakturaXlApiToken(apiToken: string): Promise<void> {
  try {
    await getDepartments(apiToken);
  } catch (error) {
    if (error instanceof FakturaXlError && error.kind === "auth") {
      throw new ApiTokenValidationError("Klucz API FakturaXL jest nieprawidłowy.");
    }
    throw error;
  }
}
