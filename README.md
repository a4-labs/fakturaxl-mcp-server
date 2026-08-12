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
| Zasięg odstępu | **Cały endpoint**, nie pojedyncze zapytanie — różne zakresy dat wysłane co 1 s też dostają `kod 2`. Okien **nie da się zrównoleglić** |
| `data_aktualizacji_od` / `data_dodania_od` | Podlegają temu samemu limitowi 31 dni (`kod 28`) — nie są obejściem |
| `na_stronie` | Maksymalnie 500; wysłanie 2000 zwraca `na_stronie: 500` |
| Filtr po kliencie | Nie istnieje w API — konieczne pobranie całego okresu i filtrowanie po naszej stronie |

Konsekwencja: 2 lata dokumentów to ~24 okna × 5 s ≈ **120 s** i nie ma sposobu, by to skrócić.
Dlatego narzędzia dokumentów zwracają kursor zamiast wisieć do timeoutu klienta (zwykle 60 s).

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

Świadomie **pominięte** (bo zakres read-only): wystawianie faktur/korekt,
wysyłka e-mail, KSeF, relacje, tagi, zmiana statusu.

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
  index.ts                 # Express + Streamable HTTP + Bearer auth + logi żądań/rozłączeń
  server.ts                # buildServer(apiToken) - instancja McpServer per request
  config.ts                # konfiguracja z .env
  logger.ts                # logger JSON + maskowanie sekretów + obcinanie body
  callContext.ts           # kontekst wywołania narzędzia (licznik zapytań do API, czas)
  tools/register.ts        # rejestracja narzędzi read-only + logowanie wywołań
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
.github/workflows/
  ci-cd.yml                # build + push obrazu do GHCR i deploy przez SSH
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

Wymaga istniejącej zewnętrznej sieci `traefik-net`. Na serwerze, w katalogu aplikacji
(u nas `/home/user/myapps/fakturaxl-mcp-server/`), tworzymy `docker-compose.yml` na
bazie szablonu i ustawiamy w nim domenę oraz certresolver:

```bash
cp docker-compose.example.yml docker-compose.yml
docker compose up -d
```

Router nasłuchuje na wskazanej domenie (entrypoint `websecure`, TLS przez
certresolver Traefika), kierując ruch na port `3000` kontenera.
W `mcp.json` klienta użyj wtedy `https://<domena>/mcp` z nagłówkiem
`Authorization: Bearer <klucz>`.

## Test lokalny (MCP Inspector)

```bash
npx @modelcontextprotocol/inspector
```

W Inspectorze: transport **Streamable HTTP**, URL `http://localhost:3000/mcp`,
nagłówek `Authorization: Bearer <klucz>`.

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
