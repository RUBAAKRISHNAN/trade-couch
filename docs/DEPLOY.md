# Deploying TradeCore (free tiers)

> **Status: not yet tested.** Everything below follows the code as written, but no deployment has been made. Free-tier
> limits change often — check each provider's current limits before relying on them.

## Shape

| Part                  | Where                               | Notes                                                                                                                         |
| --------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Web (React build)     | **Vercel**                          | Static files + rewrites that proxy `/api` and `/socket.io` to the API                                                         |
| API + engine + worker | **Render** web service              | `npm run start:prod` runs all three in one service (free plans usually don't include background workers)                      |
| PostgreSQL 17         | **Neon**                            | Needs the `citext` extension (supported)                                                                                      |
| Redis                 | **Upstash** or **Render Key Value** | Must support Streams (`XADD`/`XREADGROUP`) — both do. BullMQ polls Redis, which can use up a small free command quota quickly |

**Why proxy `/api` through Vercel instead of calling Render directly:** the refresh token lives in an httpOnly,
`SameSite=Lax` cookie. If the web app and API are on different sites (`*.vercel.app` vs `*.onrender.com`), the browser
treats the cookie as cross-site and won't send it, so sessions would break. With rewrites, the browser only ever talks to
the Vercel domain. WebSockets can't pass through Vercel rewrites; Socket.IO automatically falls back to HTTP
long-polling, which does. For native WebSockets, put both behind one custom domain instead.

## 1. Database — Neon

1. Create a project (Postgres 17) and copy the connection details.
2. From your machine, with `.env` pointing at Neon (`PG_HOST`, `PG_USER`, `PG_PASSWORD`, `PG_PORT=5432`, `DB_NAME`):

   ```bash
   npm run db:migrate
   npm run db:seed
   ```

   Neon requires TLS; if the connection is refused, add `PGSSLMODE=require` to the environment.

## 2. Redis — Upstash (or Render Key Value)

Create a Redis database and copy its `rediss://…` URL into `REDIS_URL`.

## 3. API + engine + worker — Render

1. New **Web Service** from the GitHub repo, runtime Node 22.
2. Build command: `npm ci && npm run prisma:generate`
3. Start command: `npm run start:prod`
4. Environment:

   | Variable                                                  | Value                                                                    |
   | --------------------------------------------------------- | ------------------------------------------------------------------------ |
   | `NODE_ENV`                                                | `production`                                                             |
   | `PG_HOST`, `PG_USER`, `PG_PASSWORD`, `PG_PORT`, `DB_NAME` | from Neon                                                                |
   | `PGSSLMODE`                                               | `require`                                                                |
   | `REDIS_URL`                                               | from Upstash / Render                                                    |
   | `JWT_SECRET`                                              | a long random string (the API refuses to start in production without it) |
   | `API_PORT`                                                | `10000` (or whatever Render assigns in `PORT`)                           |
   | `WEB_ORIGIN`                                              | your Vercel URL, e.g. `https://tradecore.vercel.app`                     |
   | `USD_INR`                                                 | e.g. `88`                                                                |
   | `MARKET_FEEDS`                                            | `coinbase,binance,kraken,simulated`                                      |

   Free web services usually sleep when idle; the first request after a sleep is slow, and the engine/bots pause while
   asleep.

## 4. Web — Vercel

1. New project from the repo, **root directory `apps/web`**, framework Vite.
2. Build command: `npm run build` (output `dist`).
3. Add `apps/web/vercel.json`:

   ```json
   {
     "rewrites": [
       { "source": "/api/:path*", "destination": "https://YOUR-API.onrender.com/api/:path*" },
       { "source": "/socket.io/:path*", "destination": "https://YOUR-API.onrender.com/socket.io/:path*" },
       { "source": "/((?!api|socket.io|assets).*)", "destination": "/index.html" }
     ]
   }
   ```

   The last rule serves the single-page app for routes like `/coach`. Leave `VITE_API_URL` unset (same origin).

## 5. Check it

- `https://YOUR-WEB/api/health` → `{"ok":true,…}`
- Log in as `asha@tradecore.dev` / `Demo@1234`, place a small market buy, see it in Portfolio.
- Log in as `admin@tradecore.dev`, open **Admin**, run the ledger check.
- Optionally run `npm run demo:traders` from your machine against the deployed database to make the competition move.

## Production checklist

- [ ] Change the demo password or remove the demo accounts before sharing the link widely.
- [ ] Set a real `JWT_SECRET`.
- [ ] Keep the "Virtual money · Not investment advice" banner (it's on every page).
- [ ] Consider bundling the server (`tsup`/`esbuild`) instead of running TypeScript with `tsx` in production.
