# FakturaXL MCP Server

Zdalny serwer [MCP](https://modelcontextprotocol.io) dla API [FakturaXL](https://program.fakturaxl.pl),
wystawiany pod URL przez **Streamable HTTP**. Obsługuje legacy Bearer z kluczem FakturaXL
oraz opcjonalny OAuth 2.1 dla Cursor Desktop.

Domyślnie serwer jest **read-only**. Wystawianie faktur włącza flaga `ALLOW_WRITE=true`
(patrz „Zapis: wystawianie faktur”).

## Stack

- Node.js (>=20) + TypeScript (ESM)
- `@modelcontextprotocol/sdk` v1.x (`McpServer` + `StreamableHTTPServerTransport`)
- Express (endpoint HTTP)
- `fast-xml-parser` (API FakturaXL komunikuje się XML-em)

## Instalacja

```bash
npm install
cp .env.example .env   # Windows: copy .env.example .env
```

## Uruchomienie

```bash
npm run dev     # tryb deweloperski (tsx watch)
npm run build   # kompilacja do dist/
npm start       # uruchomienie z dist/
```

Serwer nasłuchuje na `http://localhost:<PORT>/mcp` (domyślnie port `3000`).
Health check: `GET /health`.

## Konfiguracja (.env)

| Zmienna | Domyślnie | Opis |
| --- | --- | --- |
| `PORT` | `3000` | Port serwera HTTP |
| `FAKTURAXL_BASE_URL` | `https://program.fakturaxl.pl/api` | Bazowy URL API |
| `FAKTURAXL_TIMEOUT_MS` | `30000` | Timeout wywołań do FakturaXL |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `LOG_TO_FILE` | `true` | Zapis logów do `logs/fakturaxl-YYYY-MM-DD.log` |
| `TRUST_PROXY_HOPS` | `0` | Liczba zaufanych proxy; za pojedynczym Traefikiem ustaw `1` |
| `OAUTH_ENABLED` | `false` | Włącza OAuth 2.1 obok legacy Bearer |
| `PUBLIC_BASE_URL` | — | Publiczny origin serwera OAuth, np. `https://mcp.example.pl`; wymagany przy OAuth |
| `OAUTH_STORE_PATH` | `./data/oauth-store.json` | Szyfrowany magazyn klientów, grantów i kluczy FakturaXL |
| `OAUTH_STORE_KEY` | — | 32 bajty base64 do AES-256-GCM; wymagane przy OAuth |
| `OAUTH_ALLOWED_REDIRECT_URIS` | callbacki Cursor | Lista callbacków DCR rozdzielona przecinkami |
| `OAUTH_PENDING_TTL_MS` | `600000` | Ważność rozpoczętego formularza OAuth |
| `OAUTH_CODE_TTL_MS` | `300000` | Ważność jednorazowego kodu OAuth |
| `OAUTH_ACCESS_TTL_MS` | `0` | Ważność access tokenu; `0` oznacza bezterminowo |
| `OAUTH_REFRESH_TTL_MS` | `0` | Ważność rotowanego refresh tokenu; `0` oznacza bezterminowo |
| `OAUTH_AUTHORIZATION_ATTEMPTS` | `10` | Limit prób formularza per IP i okno |
| `OAUTH_AUTHORIZATION_ATTEMPT_WINDOW_MS` | `900000` | Okno limitu prób formularza |
| `ALLOW_WRITE` | `false` | Rejestruje narzędzia zapisu (wystawianie faktur) |
| `DRAFT_TTL_MS` | `600000` | Ważność tokenu podglądu z `przygotuj_fakture` |
| `DEFAULT_LIST_LIMIT` | `50` | Domyślna liczba wierszy zwracanych z list |
| `MAX_LIST_LIMIT` | `500` | Twardy górny limit zwracanych wierszy |
| `MAX_RANGE_MONTHS` | `24` | Maks. zakres dat dla auto-chunkingu (potem przycięcie + ostrzeżenie) |
| `CACHE_TTL_MS` | `300000` | TTL cache list słownikowych (klienci/produkty/...) |
| `PAGE_SIZE` | `500` | Rozmiar strony przy auto-paginacji (twardy max API = 500) |
| `RATE_LIMIT_RETRIES` | `5` | Liczba prób przy kodzie 2 (rate limit) |
| `TOOL_BUDGET_MS` | `40000` | Budżet czasu jednego wywołania narzędzia; po nim dane częściowe + kursor |
| `LOG_BODY_MAX_CHARS` | `2000` | Obcięcie body w logach (pełne tylko przy błędzie) |

## Warstwa praktyczna (agent-friendly)

Serwer nie jest cienkim wrapperem — ukrywa uciążliwości API przed agentem:

- **Auto-paginacja** — pobiera wszystkie strony pod spodem; agent nie widzi `strona`/`na_stronie`.
- **Chunking dat** — dowolny zakres jest wewnętrznie dzielony na okna ≤31 dni (limit API) i scalany. Powyżej `MAX_RANGE_MONTHS` zakres jest przycinany z ostrzeżeniem.
- **Kursor czasowy** — szeroki zakres nie zmieści się w jednym wywołaniu (patrz „Limity API” poniżej), więc narzędzie pracuje do `TOOL_BUDGET_MS` i zwraca dane częściowe z `kursor_nastepny`, `ukonczono` i `postep`. Agent kontynuuje kolejnym wywołaniem z tym kursorem. Zawsze przetwarzane jest co najmniej jedno okno, więc kursor nie może się zapętlić.
- **Natywny throttling** — rate limiter respektuje odstępy z dokumentacji (dokumenty 5 s; produkty/klienci/stany 10 s; reszta 1 s) + retry z backoff na kod 2. Kolejka jest **per token API**, bo limit obowiązuje per konto — agenci różnych kont nie blokują się wzajemnie.
- **Filtrowanie po kliencie** (którego API nie ma) — po nazwie (fuzzy) lub NIP, realizowane po stronie serwera.
- **Compact + summary + `has_more`** — listy zwracają skrócone rekordy, zawsze z agregatami (liczba, sumy per waluta, rozkład statusów/rodzajów) i informacją o obcięciu, żeby nie zalewać kontekstu agenta.
- **Cache TTL** — listy słownikowe (klienci/produkty/magazyny/działy) są cache'owane. Dokumenty **nie** są cache'owane, bo mogą być edytowane.

## Limity API FakturaXL (zweryfikowane empirycznie)

Te ograniczenia determinują architekturę narzędzi dokumentów, dlatego zostały sprawdzone
zapytaniami do produkcyjnego API, nie tylko odczytane z dokumentacji:

| Ograniczenie | Wynik testu |
| --- | --- |
| Maks. zakres `data_od`..`data_do` | 32 dni przechodzi, 35 dni zwraca `kod 28`. Używamy okien 31-dniowych |
| Odstęp między zapytaniami `lista_dokumentow.php` | Wymuszany: 3 s i 4 s → `kod 2`, 5 s → OK |
| Odstęp dla `dokument_dodaj.php` | 2 s (z dokumentacji) — wpisany do rate limitera |
| Zasięg odstępu | **Cały endpoint**, nie pojedyncze zapytanie — różne zakresy dat wysłane co 1 s też dostają `kod 2`. Okien **nie da się zrównoleglić** |
| `data_aktualizacji_od` / `data_dodania_od` | Podlegają temu samemu limitowi 31 dni (`kod 28`) — nie są obejściem |
| `na_stronie` | Maksymalnie 500; wysłanie 2000 zwraca `na_stronie: 500` |
| Filtr po kliencie | Nie istnieje w API — konieczne pobranie całego okresu i filtrowanie po naszej stronie |

Konsekwencja: 2 lata dokumentów to ~24 okna × 5 s ≈ **120 s** i nie ma sposobu, by to skrócić.
Dlatego narzędzia dokumentów zwracają kursor zamiast wisieć do timeoutu klienta (zwykle 60 s).

## Autoryzacja

Serwer obsługuje dwie zgodne wstecznie metody.

### Legacy Bearer

Klient wysyła klucz FakturaXL bezpośrednio w każdym żądaniu:

```http
Authorization: Bearer <TWOJ_KLUCZ_API_FAKTURAXL>
```

Ta metoda działa zawsze, również po włączeniu OAuth. Klucz nie jest wtedy zapisywany
przez serwer. Nieprawidłowy klucz daje błąd auth z API FakturaXL.

### OAuth 2.1 dla Cursor Desktop

OAuth jest domyślnie wyłączony. Po włączeniu Cursor wykonuje discovery, Dynamic Client
Registration i PKCE S256, po czym otwiera formularz w przeglądarce. Użytkownik podaje
klucz FakturaXL, serwer sprawdza go odczytowym `dokument_lista_dzialow.php`, szyfruje
i zapisuje grant. Cursor otrzymuje opaque access token; ten token nigdy nie jest
przekazywany do FakturaXL.

Konfiguracja klienta nie zawiera sekretu:

```json
{
  "mcpServers": {
    "fakturaxl": {
      "url": "https://mcp.example.pl/mcp"
    }
  }
}
```

Endpointy discovery i protokołu:

- `/.well-known/oauth-authorization-server`
- `/.well-known/oauth-protected-resource/mcp`
- `/register`, `/authorize`, `/token`, `/revoke`
- `/oauth/authorize/complete` — obsługa formularza, nie endpoint publicznego API

#### Uruchomienie OAuth

Wygeneruj jeden trwały klucz szyfrujący. Jego zmiana uniemożliwi odszyfrowanie
istniejącego magazynu:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Ustaw:

```dotenv
OAUTH_ENABLED=true
PUBLIC_BASE_URL=https://mcp.example.pl
OAUTH_STORE_KEY=<WYNIK_POLECENIA>
```

`PUBLIC_BASE_URL` musi być originem bez ścieżki. Produkcja wymaga HTTPS; HTTP jest
akceptowane wyłącznie dla localhost. Access i refresh token są domyślnie bezterminowe;
refresh token nadal jest rotowany przy każdym odświeżeniu. Skradziony token pozostaje
ważny do wywołania `/revoke` albo usunięcia grantu, dlatego krótsze TTL są bezpieczniejszą
opcją dla publicznych wdrożeń.

Magazyn `oauth-store.json` jest w całości szyfrowany AES-256-GCM. Kody i tokeny są
dodatkowo zapisywane tylko jako SHA-256. Zapis używa pliku tymczasowego, `fsync`
i atomowego `rename`; zły klucz szyfrujący lub uszkodzony plik zatrzymuje start.

Implementacja plikowa obsługuje wielu użytkowników, ale zakłada **jeden kontener**.
Nie skaluj tej wersji poziomo — wiele replik wymaga wspólnego magazynu transakcyjnego.

## Dostępne narzędzia (odczyt)

| Narzędzie | Opis |
| --- | --- |
| `lista_dokumentow` | Faktury dla zakresu dat + filtr klienta/statusu/typu/rodzaju. Compact + summary + `has_more` + kursor. |
| `podsumowanie_dokumentow` | Same agregaty (liczba, sumy per waluta, rozkład statusów/rodzajów) — bez wierszy. Też z kursorem; sumy z kolejnych wywołań są addytywne. |
| `pobierz_dokument` | Pełne dane pojedynczego dokumentu po ID. |
| `pobierz_pdf` | PDF dokumentu w base64. |
| `znajdz_klienta` | Wyszukiwanie klienta po nazwie/NIP. |
| `lista_klientow` | Lista klientów (opcjonalny filtr `szukaj`). |
| `znajdz_produkt` | Wyszukiwanie produktu po nazwie/kodzie/kodzie kreskowym. |
| `lista_produktow` | Lista produktów (opcjonalny filtr `szukaj`). |
| `stany_magazynowe` | Ilości produktów w magazynach. |
| `lista_magazynow` | Lista magazynów. |
| `lista_dzialow` | Lista działów firmy. |

Przykład (agent): „faktury od K8 z ostatniego kwartału” → `lista_dokumentow` z
`data_od`/`data_do` i `klient: "K8"`. Chunking, paginacja, throttling i mapowanie
nazwy klienta na `klient_id` dzieją się wewnętrznie.

Przy dłuższym zakresie odpowiedź zawiera `ukonczono: false` i `kursor_nastepny`.
Agent musi wtedy wywołać narzędzie ponownie z tym samym zakresem i `kursor` równym
tej wartości, aż `ukonczono: true`, a wyniki scalić (sumy dodać). Przy `TOOL_BUDGET_MS=40000`
jedno wywołanie obejmuje ~7 okien, czyli 2 lata to ~4 wywołania.

Świadomie **pominięte**: korekty, faktury zaliczkowe/końcowe, wysyłka e-mail, KSeF,
relacje, tagi, zmiana statusu, usuwanie dokumentów.

## Zapis: wystawianie faktur

Włączane flagą `ALLOW_WRITE=true`. Bez niej narzędzia zapisu **nie są rejestrowane**,
więc agent ich nie widzi — domyślne wdrożenie pozostaje read-only. `GET /health`
raportuje tryb (`read-only` / `read-write`).

Zakres: **Faktura VAT** (`typ_faktury=0`), przychodowa.

| Narzędzie | Opis |
| --- | --- |
| `przygotuj_fakture` | Krok 1: waliduje dane, liczy kwoty, zwraca podgląd + `token_potwierdzenia`. **Nic nie wystawia.** |
| `wystaw_fakture` | Krok 2: wystawia dokument przygotowany w kroku 1. Wymaga `token_potwierdzenia` i `potwierdzam: true`. |

Dlaczego dwa kroki: wystawienie faktury jest nieodwracalne (zużywa numer z ciągłej
numeracji), a MCP nie ma UI z przyciskiem potwierdzenia. Bariera siedzi więc
w protokole — agent musi najpierw pokazać użytkownikowi podgląd z kwotami.

Token daje przy okazji **idempotencję, której API FakturaXL nie ma**: klient MCP
potrafi powtórzyć wywołanie po timeoucie, a zużyty draft zwraca pierwotny dokument
zamiast wystawiać drugi. Drafty żyją w pamięci procesu (TTL `DRAFT_TTL_MS`),
więc restart unieważnia te niepotwierdzone.

Kwoty w podglądzie liczymy lokalnie w groszach (float gubi grosze na sumach
pozycji), wyłącznie po to, żeby użytkownik zobaczył wartość **przed** wystawieniem.
Ostateczne kwoty nalicza FakturaXL — w teście E2E obie liczby były identyczne
(`230.00` / `52.90` / `282.90`).

### Pułapki API przy zapisie (zweryfikowane sondą)

| Ustalenie | Konsekwencja |
| --- | --- |
| Dokument bez kraju nabywcy, dat, waluty i rodzaju płatności zwraca kody **11, 13, 15, 18** | Wszystkie te pola mają wartości domyślne (dziś, `PLN`, `Przelew`, `PL`) |
| Odpowiedź zawiera **wiele tagów `<kod>`** naraz | `assertNoErrorCode` raportuje wszystkie przyczyny, nie tylko pierwszą |
| `<nabywca><klient_id>` **nie jest obsługiwane** na wejściu (kody 9 i 11) | Dane nabywcy trzeba przepisać z `znajdz_klienta` |
| API samo dopasowuje klienta po NIP i wpisuje `klient_id` do dokumentu | Duplikaty klientów nie powstają |
| `lista_klientow` zwraca `<kraj_id>`, a `dokument_dodaj` oczekuje `<kraj>` | Różne nazwy pól na wejściu i wyjściu |
| Encja `&amp;` wraca jako `&` | CDATA jest zbędne, escapowanie `XMLBuilder` wystarcza |
| Każda pozycja zakłada nowy produkt w katalogu (`produkt_id` w odczycie) | Wystawianie faktur zaśmieca listę produktów |
| `cena_netto` + `rabat` liczy się zgodnie z dokumentacją | 2 × 100 netto − 10% = netto 180.00, VAT 41.40, brutto 221.40 |

## Logowanie

Logi są w formacie JSON (jedna linia = jedno zdarzenie). **Token API jest zawsze
maskowany** (widoczne tylko ostatnie 4 znaki). Trafiają na konsolę oraz — gdy
`LOG_TO_FILE=true` — do katalogu `logs/`.

Rejestrowane zdarzenia:

| Zdarzenie | Kiedy i co zawiera |
| --- | --- |
| `mcp.request` / `mcp.request_handled` | Każde żądanie HTTP: metoda JSON-RPC, nazwa narzędzia, czas trwania |
| `mcp.tool_call` / `mcp.tool_result` | Wywołanie narzędzia: argumenty, czas trwania, **liczba zapytań do API**, liczba rekordów, czy zwrócono kursor |
| `mcp.client_disconnected` | Klient rozłączył się przed końcem odpowiedzi — **tak objawia się timeout agenta** |
| `mcp.tool_error` / `mcp.handler_error` | Błąd narzędzia lub transportu z czasem trwania |
| `fakturaxl.request` / `fakturaxl.response` | Raw request/response do FakturaXL (URL, nagłówki, body, status, czas) |
| `fakturaxl.network_error` / `.http_error` / `.parse_error` | Błędy komunikacji — z **pełnym**, nieobciętym body |

Body request/response jest obcinane do `LOG_BODY_MAX_CHARS` (odpowiedzi API sięgają
setek KB). Pełne body jest logowane tylko przy błędach. Kontenery mają ustawioną
rotację logów Dockera (`max-size: 10m`, `max-file: 3`).

## Struktura

```
src/
  index.ts                 # inicjalizacja OAuth i start procesu HTTP
  app.ts                   # Express + Streamable HTTP + dual auth + logi żądań/rozłączeń
  server.ts                # buildServer(apiToken) - instancja McpServer per request
  config.ts                # konfiguracja z .env
  logger.ts                # logger JSON + maskowanie sekretów + obcinanie body
  callContext.ts           # kontekst wywołania narzędzia (licznik zapytań do API, czas)
  auth/
    runtime.ts             # router OAuth SDK, metadata i trwały runtime
    provider.ts            # DCR, authorize, token, refresh, revoke i formularz
    store.ts               # szyfrowany, atomowy magazyn JSON
    resolveCredential.ts   # OAuth access token lub legacy klucz FakturaXL
    validateApiToken.ts    # odczytowa walidacja klucza przed wydaniem grantu
    ui.ts                  # responsywny formularz autoryzacji
  tools/runner.ts          # wspólny wrapper narzędzia (kontekst pomiarowy + logi)
  tools/register.ts        # rejestracja narzędzi odczytu
  tools/registerWrite.ts   # rejestracja narzędzi zapisu (tylko przy ALLOW_WRITE)
  fakturaxl/invoice.ts     # schema faktury VAT, wyliczenia podglądu, mapowanie na XML
  fakturaxl/drafts.ts      # drafty faktur (dwa kroki + idempotencja)
  fakturaxl/client.ts      # XML->POST->JSON, mapowanie błędów, rate limiter + retry
  fakturaxl/rateLimiter.ts # throttling per (token + endpoint) wg odstępów z dokumentacji
  fakturaxl/pagination.ts  # auto-paginacja (fetchAllPages)
  fakturaxl/dates.ts       # chunking zakresu dat na okna <=31 dni + cap 24 mies.
  fakturaxl/cache.ts       # cache TTL w pamięci (tylko listy słownikowe)
  fakturaxl/service.ts     # getDocuments z budżetem czasu i kursorem, findClients/Products
  fakturaxl/compact.ts     # compact mappery + agregacja (summary)
  fakturaxl/codes.ts       # mapa kodów zwracanych przez API
docs/
  api-fakturaxl.md         # dokumentacja API FakturaXL
  diagram.md               # architektura dual auth i przepływ sekretów
  etap 1/backlog.md        # wykonanie wystawiania faktur
  etap 2/backlog.md        # wykonanie OAuth 2.1
.github/workflows/
  ci-cd.yml                # build + push obrazu do GHCR i deploy przez SSH
Dockerfile                 # multi-stage: build / runtime (prod) / dev
docker-compose.dev.yml     # lokalny dev (hot-reload, bez Traefika)
docker-compose.example.yml # szablon compose produkcyjnego (Traefik) do skopiowania
```

## Docker

Legacy Bearer pozostaje bezstanowy. Po włączeniu OAuth stan trafia do
`./data/oauth-store.json`, montowanego jako `/app/data/oauth-store.json`.
Katalog nie trafia do obrazu ani repozytorium.

Pliki:
- `Dockerfile` — multi-stage (`build` → `runtime` produkcyjny, oraz `dev` z hot-reload). Obraz produkcyjny na `node:22-alpine`, uruchamiany jako user `node`, z healthcheckiem `/health`.
- `docker-compose.dev.yml` — lokalny development, port `3000:3000` i bind mount `./data`.
- `docker-compose.example.yml` — produkcja za Traefikiem z TLS i bind mount `./data`.

### Dev (lokalnie)

```bash
mkdir data
docker compose -f docker-compose.dev.yml up --build
# MCP: http://localhost:3000/mcp   health: http://localhost:3000/health
```

Na Windowsie uprawnienia bind mountu obsługuje Docker Desktop. Na natywnym Linuksie
katalog musi należeć do UID/GID `1000`, bo proces działa jako user `node`.

### Serwer (produkcja, Traefik)

Wymaga istniejącej zewnętrznej sieci `traefik-net`. Na serwerze, w katalogu aplikacji
(u nas `/home/user/myapps/fakturaxl-mcp-server/`), tworzymy `docker-compose.yml` na
bazie szablonu, przygotowujemy katalog danych i ustawiamy `.env`:

```bash
cp docker-compose.example.yml docker-compose.yml
mkdir -p data
sudo chown 1000:1000 data
chmod 700 data
# .env: MCP_DOMAIN, TRAEFIK_CERTRESOLVER, OAUTH_ENABLED i OAUTH_STORE_KEY
docker compose up -d
```

Plik jest tworzony z trybem `600`. Backupuj `data/oauth-store.json` razem z bezpiecznie
przechowywanym `OAUTH_STORE_KEY`; sam plik bez klucza jest nieczytelny. Nie używaj
`docker compose down -v` jako procedury sprzątania danych i nie uruchamiaj drugiej repliki.

Router nasłuchuje na wskazanej domenie (entrypoint `websecure`, TLS przez
certresolver Traefika), kierując ruch na port `3000` kontenera.
W `mcp.json` użyj samego URL dla OAuth albo dodaj nagłówek
`Authorization: Bearer <klucz>` dla trybu legacy.

## Test lokalny (MCP Inspector)

```bash
npx @modelcontextprotocol/inspector
```

W Inspectorze: transport **Streamable HTTP**, URL `http://localhost:3000/mcp`,
nagłówek `Authorization: Bearer <klucz>`.

Test OAuth w Cursor Desktop: włącz OAuth z `PUBLIC_BASE_URL=http://localhost:3000`,
zostaw w konfiguracji MCP wyłącznie `url`, uruchom ponownie Cursor i wybierz połączenie.
Przeglądarka powinna otworzyć formularz, a callback wrócić na
`http://localhost:8787/callback`.

## Wdrożenie produkcyjne (CI/CD)

Wdrożenie jest **automatyczne**: każdy push do `main` uruchamia
`.github/workflows/ci-cd.yml`, który buduje obraz, wypycha go do GHCR i wchodzi na
serwer przez SSH, żeby zrobić `docker compose pull && up -d`. Ręcznie można go odpalić
przez `workflow_dispatch` (`gh workflow run "Build & Deploy"`).

Jak to działa:

1. **Build i push** — obraz `ghcr.io/socialbuzzstudio/fakturaxl-mcp-server` w tagach `latest`
   i wersji z `package.json`. Build używa `target: runtime` — to obowiązkowe, bo ostatnim
   etapem `Dockerfile` jest `dev` z hot-reloadem. Kompilacja TypeScript dzieje się w etapie
   build, więc błąd typów zatrzymuje CI. Publikacja idzie wbudowanym `GITHUB_TOKEN`
   (job ma `packages: write`) — żadnych własnych PAT-ów.
2. **Deploy** — `appleboy/ssh-action` loguje się na serwer kluczem z sekretu, robi
   `docker login ghcr.io` tokenem ważnym **tylko na czas tego przebiegu**, pobiera obraz,
   restartuje kontener i się wylogowuje. Serwer nie przechowuje żadnych poświadczeń do rejestru.

Paczka w GHCR jest **prywatna**, mimo że repozytorium jest publiczne — w GHCR widoczność
paczki jest niezależna od widoczności repo i domyślnie ustawiona na prywatną. Paczka
dziedziczy uprawnienia dostępu z repo, dzięki czemu job deployu ma do niej dostęp bez
dodatkowej konfiguracji. Uwaga: zmiana paczki na publiczną jest **nieodwracalna**.

Wymagane sekrety w repozytorium (ustawiane przez `gh secret set`, nie klikane w przeglądarce):

| Sekret | Zawartość |
| --- | --- |
| `SSH_HOST` | IP serwera |
| `SSH_USERNAME` | użytkownik SSH używany do deployu |
| `SSH_PRIVATE_KEY` | klucz prywatny osobnej pary wygenerowanej tylko pod CI/CD |

Klucz prywatny podaje się przez potok (`Get-Content -Raw ... | gh secret set ...`), a nie
przez `--body` — musi wejść w całości, z liniami BEGIN/END, inaczej deploy padnie na
„invalid format".

Bez Dockera (wdrożenie ręczne): `npm ci && npm run build && npm start` za reverse proxy
(nginx/Caddy/Traefik) z TLS, kierującym `/mcp` na port aplikacji.
