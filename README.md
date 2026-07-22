# FakturaXL MCP Server

Zdalny, **read-only** serwer [MCP](https://modelcontextprotocol.io) dla API [FakturaXL](https://program.fakturaxl.pl).
Wystawiany pod URL przez **Streamable HTTP** — klient MCP podaje adres serwera oraz klucz API FakturaXL w nagłówku `Authorization: Bearer`.

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
| `DEFAULT_LIST_LIMIT` | `50` | Domyślna liczba wierszy zwracanych z list |
| `MAX_LIST_LIMIT` | `500` | Twardy górny limit zwracanych wierszy |
| `MAX_RANGE_MONTHS` | `24` | Maks. zakres dat dla auto-chunkingu (potem przycięcie + ostrzeżenie) |
| `CACHE_TTL_MS` | `300000` | TTL cache list słownikowych (klienci/produkty/...) |
| `PAGE_SIZE` | `500` | Rozmiar strony przy auto-paginacji |
| `RATE_LIMIT_RETRIES` | `5` | Liczba prób przy kodzie 2 (rate limit) |

## Warstwa praktyczna (agent-friendly)

Serwer nie jest cienkim wrapperem — ukrywa uciążliwości API przed agentem:

- **Auto-paginacja** — pobiera wszystkie strony pod spodem; agent nie widzi `strona`/`na_stronie`.
- **Chunking dat** — dowolny zakres jest wewnętrznie dzielony na okna ≤31 dni (limit API) i scalany. Powyżej `MAX_RANGE_MONTHS` zakres jest przycinany z ostrzeżeniem.
- **Natywny throttling** — globalny rate limiter respektuje odstępy z dokumentacji (dokumenty 5 s; produkty/klienci/stany 10 s; reszta 1 s) + retry z backoff na kod 2. Agent nigdy nie dostaje błędu limitu.
- **Filtrowanie po kliencie** (którego API nie ma) — po nazwie (fuzzy) lub NIP, realizowane po stronie serwera.
- **Compact + summary + `has_more`** — listy zwracają skrócone rekordy, zawsze z agregatami (liczba, sumy per waluta, rozkład statusów/rodzajów) i informacją o obcięciu, żeby nie zalewać kontekstu agenta.
- **Cache TTL** — listy słownikowe (klienci/produkty/magazyny/działy) są cache'owane, co przyspiesza wyszukiwanie i ogranicza wywołania.

## Autoryzacja

Jeden sekret: **klucz API FakturaXL = token Bearer**.
Klient MCP wysyła w każdym żądaniu nagłówek:

```
Authorization: Bearer <TWOJ_KLUCZ_API_FAKTURAXL>
```

Brak nagłówka → HTTP 401. Nieprawidłowy klucz → FakturaXL zwraca kod `3`,
mapowany na czytelny błąd narzędzia. Serwer działa w trybie **stateless**
(nowa instancja per request; klucz nie jest nigdzie przechowywany).

## Dostępne narzędzia (tylko odczyt)

| Narzędzie | Opis |
| --- | --- |
| `lista_dokumentow` | Faktury dla dowolnego zakresu dat + filtr klienta/statusu/typu/rodzaju. Compact + summary + `has_more`. |
| `podsumowanie_dokumentow` | Same agregaty (liczba, sumy per waluta, rozkład statusów/rodzajów) — bez wierszy. |
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

Świadomie **pominięte** (bo zakres read-only): wystawianie faktur/korekt,
wysyłka e-mail, KSeF, relacje, tagi, zmiana statusu.

## Logowanie

Każde wywołanie API FakturaXL logowane jest jako raw request/response
(URL, nagłówki, body, status). **Token API jest maskowany** (widoczne tylko
ostatnie 4 znaki). Logi trafiają na konsolę oraz — gdy `LOG_TO_FILE=true` —
do katalogu `logs/`.

## Struktura

```
src/
  index.ts                 # Express + Streamable HTTP + Bearer auth + error handler
  server.ts                # buildServer(apiToken) - instancja McpServer per request
  config.ts                # konfiguracja z .env
  logger.ts                # logger JSON + maskowanie sekretów
  tools/register.ts        # rejestracja narzędzi read-only (compact + summary + limit)
  fakturaxl/client.ts      # XML->POST->JSON, mapowanie błędów, rate limiter + retry
  fakturaxl/rateLimiter.ts # globalny throttling per endpoint (odstępy z dokumentacji)
  fakturaxl/pagination.ts  # auto-paginacja (fetchAllPages)
  fakturaxl/dates.ts       # chunking zakresu dat na okna <=31 dni + cap 24 mies.
  fakturaxl/cache.ts       # cache TTL w pamięci
  fakturaxl/service.ts     # getDocuments, findClients/Products, listy słownikowe
  fakturaxl/compact.ts     # compact mappery + agregacja (summary)
  fakturaxl/codes.ts       # mapa kodów zwracanych przez API
docs/
  api-fakturaxl.md         # dokumentacja API FakturaXL
Dockerfile                 # multi-stage: build / runtime (prod) / dev
docker-compose.dev.yml     # lokalny dev (hot-reload, bez Traefika)
docker-compose.example.yml # szablon compose produkcyjnego (Traefik) do skopiowania
```

## Docker

Serwer jest **bezstanowy i nie przechowuje sekretów** — klucz API FakturaXL podaje
klient MCP per request (Bearer). Dlatego obrazy/compose nie zawierają danych wrażliwych.

Pliki:
- `Dockerfile` — multi-stage (`build` → `runtime` produkcyjny, oraz `dev` z hot-reload). Obraz produkcyjny na `node:22-alpine`, uruchamiany jako user `node`, z healthcheckiem `/health`.
- `docker-compose.dev.yml` — lokalny development (tsx watch, port `3000:3000`, bez Traefika).
- `docker-compose.example.yml` — szablon produkcyjny za Traefikiem (TLS, zewnętrzna sieć `traefik-net`) do skopiowania i dostosowania (`MCP_DOMAIN`, `TRAEFIK_CERTRESOLVER`).

### Dev (lokalnie)

```bash
docker compose -f docker-compose.dev.yml up --build
# MCP: http://localhost:3000/mcp   health: http://localhost:3000/health
```

### Serwer (produkcja, Traefik)

Wymaga istniejącej zewnętrznej sieci `traefik-net`. Skopiuj szablon i ustaw domenę/certresolver przez zmienne:

```bash
cp docker-compose.example.yml docker-compose.yml
# w .env obok compose:
#   MCP_DOMAIN=fakturaxl-mcp.twoja-domena.pl
#   TRAEFIK_CERTRESOLVER=myresolver
docker compose up -d
```

Router nasłuchuje na `${MCP_DOMAIN}` (entrypoint `websecure`, TLS przez
`${TRAEFIK_CERTRESOLVER:-myresolver}`), kierując ruch na port `3000` kontenera.
W `mcp.json` klienta użyj wtedy `https://<MCP_DOMAIN>/mcp` z nagłówkiem
`Authorization: Bearer <klucz>`.

## Test lokalny (MCP Inspector)

```bash
npx @modelcontextprotocol/inspector
```

W Inspectorze: transport **Streamable HTTP**, URL `http://localhost:3000/mcp`,
nagłówek `Authorization: Bearer <klucz>`.

## Wdrożenie produkcyjne (Linux)

Rekomendowana ścieżka to Docker + Traefik (sekcja „Docker" powyżej):

```bash
MCP_DOMAIN=fakturaxl-mcp.twoja-domena.pl docker compose up -d --build
```

Alternatywnie bez Dockera: `npm ci && npm run build && npm start` za reverse proxy
(nginx/Caddy/Traefik) z TLS, kierującym `/mcp` na port aplikacji.
