# Network Search Practices

Use this when the task needs current external facts, web discovery, source comparison, or search-engine setup. Prefer fast direct search URLs for simple discovery; install/run SearXNG only when a local/private meta-search service is explicitly useful.

## Fast Google URL

Construct a Google search URL and open it in Brave or the available browser:

```text
https://www.google.com/search?q=<url-encoded-query>
```

Useful query operators:

- exact phrase: `"quoted phrase"`
- site scope: `site:example.com query`
- exclude term: `query -excluded`
- file type: `filetype:pdf query`
- date hint: include the year/month in the query; use Google's UI tools if needed.

Shell helper:

```bash
python3 - <<'PY'
from urllib.parse import quote_plus
q = 'site:github.com rin agent practices'
print('https://www.google.com/search?q=' + quote_plus(q))
PY
```

After opening results, collect source URLs, titles, dates, and quoted evidence. Do not cite the search result page itself as evidence when a primary source is available.

## When to use SearXNG

Use SearXNG when you need repeatable local meta-search, reduced direct Google interaction, multiple engines, or a private team search endpoint. Do not assume Rin ships SearXNG; install it as a separate service when needed.

## Quick SearXNG install with Docker

```bash
mkdir -p ~/searxng
cd ~/searxng
cat > docker-compose.yml <<'YAML'
services:
  searxng:
    image: searxng/searxng:latest
    ports:
      - "127.0.0.1:8080:8080"
    volumes:
      - ./searxng:/etc/searxng
    environment:
      - SEARXNG_BASE_URL=http://127.0.0.1:8080/
YAML
docker compose up -d
```

Open:

```text
http://127.0.0.1:8080/search?q=your+query
```

JSON API check, if enabled by settings:

```bash
curl 'http://127.0.0.1:8080/search?q=rin&format=json'
```

## Native SearXNG notes

- Follow upstream SearXNG documentation for production deployment.
- Bind to `127.0.0.1` unless intentionally exposing it.
- Keep `secret_key`, enabled engines, rate limits, and public-instance settings explicit.
- Record the service URL and settings path in the task handoff.

## Evidence bundle

For search-driven answers, report:

- query string or constructed URL;
- result URLs actually opened;
- primary-source quotes/facts;
- date/version constraints;
- uncertainty or sources not checked.
