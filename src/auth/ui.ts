import { randomBytes } from "node:crypto";

export interface AuthorizationPage {
  html: string;
  contentSecurityPolicy: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function callbackCspSource(redirectUri: string | undefined): string | undefined {
  if (!redirectUri) return undefined;
  try {
    const parsed = new URL(redirectUri);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.origin : parsed.protocol;
  } catch {
    return undefined;
  }
}

function pageShell(title: string, content: string, nonce: string, redirectUri?: string): AuthorizationPage {
  const formActionSources = ["'self'", callbackCspSource(redirectUri)].filter(
    (source): source is string => source !== undefined,
  );
  return {
    contentSecurityPolicy: [
      "default-src 'none'",
      `style-src 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
      "base-uri 'none'",
      `form-action ${formActionSources.join(" ")}`,
      "frame-ancestors 'none'",
    ].join("; "),
    html: `<!doctype html>
<html lang="pl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>${escapeHtml(title)}</title>
  <style nonce="${nonce}">
    :root {
      color-scheme: light dark;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --background: #f8fafc;
      --surface: #ffffff;
      --text: #0f172a;
      --muted: #475569;
      --border: #cbd5e1;
      --input: #ffffff;
      --primary: #15803d;
      --primary-hover: #166534;
      --primary-text: #ffffff;
      --error-bg: #fef2f2;
      --error-border: #fca5a5;
      --error-text: #991b1b;
      --focus: #16a34a;
    }
    * { box-sizing: border-box; }
    body {
      min-height: 100vh;
      margin: 0;
      display: grid;
      place-items: center;
      padding: 24px 16px;
      background: var(--background);
      color: var(--text);
    }
    main {
      width: min(100%, 440px);
      padding: 28px 24px;
      border: 1px solid var(--border);
      border-radius: 16px;
      background: var(--surface);
      box-shadow: 0 12px 32px rgb(15 23 42 / 10%);
    }
    h1 { margin: 0 0 10px; font-size: clamp(1.5rem, 5vw, 2rem); line-height: 1.2; }
    p { margin: 0; color: var(--muted); line-height: 1.55; }
    form { margin-top: 24px; }
    label { display: block; margin-bottom: 8px; font-weight: 600; }
    .input-row { display: grid; grid-template-columns: 1fr auto; gap: 8px; }
    input, button {
      min-height: 48px;
      border-radius: 10px;
      font: inherit;
    }
    input {
      min-width: 0;
      width: 100%;
      padding: 11px 12px;
      border: 1px solid var(--border);
      background: var(--input);
      color: var(--text);
    }
    input:focus-visible, button:focus-visible {
      outline: 3px solid color-mix(in srgb, var(--focus) 35%, transparent);
      outline-offset: 2px;
    }
    button { cursor: pointer; transition: background-color 180ms ease, border-color 180ms ease; }
    .toggle {
      padding: 0 14px;
      border: 1px solid var(--border);
      background: transparent;
      color: var(--text);
    }
    .toggle:hover { border-color: var(--primary); }
    .submit {
      width: 100%;
      margin-top: 16px;
      padding: 11px 18px;
      border: 1px solid var(--primary);
      background: var(--primary);
      color: var(--primary-text);
      font-weight: 700;
    }
    .submit:hover { background: var(--primary-hover); border-color: var(--primary-hover); }
    .submit:disabled { cursor: wait; opacity: .75; }
    .hint { margin-top: 16px; font-size: .875rem; }
    .error {
      margin: 18px 0 0;
      padding: 12px 14px;
      border: 1px solid var(--error-border);
      border-radius: 10px;
      background: var(--error-bg);
      color: var(--error-text);
      line-height: 1.45;
    }
    @media (max-width: 374px) {
      main { padding: 24px 18px; }
      .input-row { grid-template-columns: 1fr; }
      .toggle { width: 100%; }
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --background: #0f172a;
        --surface: #1e293b;
        --text: #f8fafc;
        --muted: #cbd5e1;
        --border: #475569;
        --input: #0f172a;
        --primary: #22c55e;
        --primary-hover: #16a34a;
        --primary-text: #052e16;
        --error-bg: #450a0a;
        --error-border: #b91c1c;
        --error-text: #fecaca;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      button { transition: none; }
    }
  </style>
</head>
<body>
  <main>${content}</main>
  <script nonce="${nonce}">
    const form = document.querySelector("form");
    const input = document.querySelector("#api-key");
    const toggle = document.querySelector("#toggle-key");
    const submit = document.querySelector("#submit-key");
    if (toggle && input) {
      toggle.addEventListener("click", () => {
        const hidden = input.type === "password";
        input.type = hidden ? "text" : "password";
        toggle.textContent = hidden ? "Ukryj" : "Pokaż";
        toggle.setAttribute("aria-pressed", String(hidden));
      });
    }
    if (form && submit) {
      form.addEventListener("submit", () => {
        submit.disabled = true;
        submit.textContent = "Sprawdzanie klucza…";
        form.setAttribute("aria-busy", "true");
      });
    }
  </script>
</body>
</html>`,
  };
}

export function authorizationPage(input: {
  pendingId: string;
  csrfToken: string;
  redirectUri: string;
  error?: string;
}): AuthorizationPage {
  const nonce = randomBytes(18).toString("base64");
  const error = input.error
    ? `<div class="error" role="alert">${escapeHtml(input.error)}</div>`
    : "";
  return pageShell(
    "Połącz FakturaXL",
    `<h1>Połącz FakturaXL</h1>
    <p>Podaj klucz API konta, które ma być dostępne w kliencie MCP.</p>
    ${error}
    <form method="post" action="/oauth/authorize/complete">
      <input type="hidden" name="pending_id" value="${escapeHtml(input.pendingId)}">
      <input type="hidden" name="csrf_token" value="${escapeHtml(input.csrfToken)}">
      <label for="api-key">Klucz API FakturaXL</label>
      <div class="input-row">
        <input id="api-key" name="api_key" type="password" required maxlength="512"
          autocomplete="off" autocapitalize="none" spellcheck="false" autofocus>
        <button id="toggle-key" class="toggle" type="button" aria-controls="api-key" aria-pressed="false">Pokaż</button>
      </div>
      <button id="submit-key" class="submit" type="submit">Połącz z FakturaXL</button>
    </form>
    <p class="hint">Klucz zostanie sprawdzony, zaszyfrowany i zapisany wyłącznie na tym serwerze.</p>`,
    nonce,
    input.redirectUri,
  );
}

export function expiredAuthorizationPage(): AuthorizationPage {
  const nonce = randomBytes(18).toString("base64");
  return pageShell(
    "Autoryzacja wygasła",
    `<h1>Autoryzacja wygasła</h1>
    <p>Wróć do klienta MCP i rozpocznij łączenie z serwerem ponownie.</p>`,
    nonce,
  );
}
