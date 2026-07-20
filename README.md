# Starship Flight Tracker

**Live:** [starship-flight-tracker.com](https://starship-flight-tracker.com)

Starship flight status, news-derived signals, and a Monte Carlo cadence projection. Hosted on Cloudflare’s free tier — no home machine required.

| Piece | Role |
|--------|------|
| Worker | Serves the React SPA + `/api/*` |
| D1 | SQLite-compatible store (flights, signals, articles, meta) |
| KV | Cached cadence JSON (`cadence` key) |
| Cron | Hourly tick → poll LL2 / Spaceflight News / (optional) Anthropic when due |

## UI

Responsive layout via CSS media queries (and a small `matchMedia` hook for the chart):

- **&lt; 960px** — stacked mobile layout (chart above, upcoming flights below)
- **≥ 960px** — desktop: chart + year outlook on the left, flight list on the right
- **≥ 1280px** — taller chart, wider columns

Hard-refresh after deploys (Cmd+Shift+R / Ctrl+Shift+R).

## Local development

```bash
# Terminal 1 — API + assets (Miniflare)
cd worker
npm install
npx wrangler d1 migrations apply starship-tracker --local
npm run dev          # http://127.0.0.1:8788

# Terminal 2 — Vite HMR (optional; proxies /api → :8788)
cd web
npm install
npm run dev          # http://127.0.0.1:5173
```

Secrets for local Miniflare go in `worker/.dev.vars` (gitignored):

```
ANTHROPIC_API_KEY=
LL2_API_KEY=
ADMIN_TOKEN=dev-token
```

Force a poll cycle:

```bash
curl -X POST 'http://127.0.0.1:8788/api/refresh?force_ll2=true' \
  -H "X-Admin-Token: $ADMIN_TOKEN"
```

## Production deploy

```bash
cd worker
npm run deploy       # builds web/dist then wrangler deploy
```

Custom domains (`starship-flight-tracker.com` + `www`) are in [`worker/wrangler.jsonc`](worker/wrangler.jsonc).

### Secrets (Cloudflare dashboard will not show values again)

```bash
cd worker
npx wrangler secret put ADMIN_TOKEN          # any long random string you choose
npx wrangler secret put ANTHROPIC_API_KEY    # optional; heuristics without it
npx wrangler secret put LL2_API_KEY          # optional
```

Generate a token: `openssl rand -hex 24`. Store it somewhere safe (e.g. `~/.starship_admin_token`). To rotate, run `secret put` again with a new value.

Live force-refresh:

```bash
TOKEN=$(cat ~/.starship_admin_token)
curl -sS -X POST 'https://starship-flight-tracker.com/api/refresh?force_ll2=true' \
  -H "X-Admin-Token: $TOKEN"
```

### One-time resource setup (already done for this project)

```bash
npx wrangler login
npx wrangler d1 create starship-tracker      # → database_id in wrangler.jsonc
npx wrangler kv namespace create CACHE         # → id in wrangler.jsonc
npx wrangler d1 migrations apply starship-tracker --remote
```

### Import from a local Python `tracker.db` (optional)

```bash
# from the parent starship_flight_tracker checkout
python3 cloudflare/scripts/export_sqlite_to_d1.py \
  --db data/tracker.db \
  --out cloudflare/scripts/d1_data.sql
cd cloudflare/worker
npx wrangler d1 execute starship-tracker --remote --file=../scripts/d1_data.sql
```

Bootstrap cadence into KV if `/api/cadence` is empty:

```bash
cd worker
npx vitest run test/bootstrap_cadence.test.ts
npx wrangler kv key put cadence --binding=CACHE --remote \
  --path=../scripts/cadence_bootstrap.json
```

## Architecture notes

- **Cadence model** — TypeScript port (~150 sims) of the original Python Monte Carlo, sized for the Workers free-tier **10 ms CPU** cap. Same UI payload shape; drops hurricane-season / Florida-first / weather-hazard branches. Recomputed when the input fingerprint changes; `GET /api/cadence` is a KV read.
- **`POST /api/refresh`** — requires `X-Admin-Token`; not exposed in the UI.
- **Poll schedule** — hourly cron; idle days only poll at `POLL_IDLE_HOUR_LOCAL` (default 8 AM `America/Denver`); near-launch windows poll every hour.
- **API** — `GET /api/health`, `/api/flights`, `/api/flights/:n`, `/api/cadence`, `/api/signals`; `POST /api/refresh`.

## Tests

```bash
cd worker
npm test
npm run typecheck
```

## Layout

```
cloudflare/
├── README.md
├── scripts/
│   ├── export_sqlite_to_d1.py
│   └── … (d1_data.sql / cadence_bootstrap.json gitignored)
├── web/                 # Vite + React SPA
└── worker/
    ├── wrangler.jsonc
    ├── migrations/
    ├── seeds/
    ├── src/             # API, poll, LL2, news, extract, cadence
    └── test/
```

The Python FastAPI app under `../server` + `../run.sh` is the original LAN stack (reference / offline research). Production is this Cloudflare Worker.
