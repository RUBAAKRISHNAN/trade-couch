# Progress Log

## Phase 1 + 2 — Monorepo, database, matching engine ✅

**Built**

- npm-workspaces monorepo (`apps/{api,engine,worker,web}`, `packages/shared`), TypeScript strict, ESLint 9 flat config, Prettier, Vitest projects.
- Databases `tradecore` and `tradecore_test` created; migration `0001_init.sql`: 20 tables, CHECK constraints
  (`cash >= 0`, `held <= cash`, `qty >= 0`, `tick % qty_scale = 0`, …), FKs, `UNIQUE NULLS NOT DISTINCT`,
  daily range partitions for `trades` and `order_events` (+ `ensure_daily_partitions()`), composite B-tree
  and BRIN indexes, append-only `audit_log` filled by triggers on every balance change.
- Matching engine (`apps/engine/src/book`): limit / market / stop-market / stop-limit, GTC / IOC / FOK,
  cancel, amend (priority rules), price-time priority, partial fills, self-trade prevention, tick/lot/price-band
  checks, halt/resume, event log with gap-free seq, deterministic replay.
- Tests: 19 example tests + 2 property tests (fast-check, 600 random sequences of 10–200 commands each) checking:
  book never crossed, cash & quantity conserved, holds never exceed balances, per-order quantity bookkeeping,
  price-time priority (makers hit = prefix of the queue), replay (full log and any prefix) == live book.
  Mutation-checked: deliberately breaking FIFO or self-trade prevention makes the property tests fail.
- Benchmark `npm run bench:engine` (see docs/PERFORMANCE.md).

## Phase 4 + 5 (backend part) — Market data, bots, live services, API ✅

**Built**
- Market data (`apps/worker/src/market`): `MarketDataProvider` interface; adapters for **Coinbase**, **Binance**
  (USDT≈USD) and **Kraken** WebSockets (reconnect with jittered exponential backoff, silence watchdog);
  seeded **GBM `SimulatedFeed`**; `FeedManager` picks the highest-priority *fresh* source, fails over on staleness,
  and re-anchors the simulator to every live tick so an offline fallback continues smoothly. USD→INR via config.
  Verified on this machine: Coinbase ✓, Binance ✓, Kraken ✗ (blocked at network level here; the adapter is kept).
- Engine service: one serial queue per symbol, Redis Streams in/out with consumer groups, stable consumer name,
  crash recovery = Postgres event log + unsettled stream tail; book snapshots throttled to 10/s.
- Worker: settler per symbol behind a Redis lease (single writer), market-maker bots (ladder + inventory skew,
  re-quote on ≥6 bps moves), flow-trader bots (small market orders), BullMQ jobs (partitions, pruning).
- API (Fastify): auth (bcrypt, 15-min JWT, rotating refresh cookie with reuse detection), orders, portfolio,
  market data (candles via window functions + MA20), Swagger UI at `/docs`, helmet, CORS allowlist, request IDs,
  Redis rate limits (auth 20/min, orders 30/10s), central error handler. Socket.io with Redis adapter and
  per-channel throttling/batching.
- `npm run smoke`: runs engine + worker, then checks trades happened and invariants hold
  (30 s run: 42 trades, 1,478 events settled, Coinbase reference price, all invariants ✓).
- Tests: 48 passing (engine 21, api 19, worker 8).

**Found & fixed by tests:** refresh-token reuse revocation was rolled back by the thrown error (security bug).
