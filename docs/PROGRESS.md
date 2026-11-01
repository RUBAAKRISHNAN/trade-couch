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
  seeded **GBM `SimulatedFeed`**; `FeedManager` picks the highest-priority _fresh_ source, fails over on staleness,
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

## MVP milestone ✅ — BTC end-to-end, trading terminal + portfolio

**Built**

- Web (`apps/web`): Vite + React 19 + Tailwind v4 + shadcn/ui-style components (Radix), TanStack Query, Zustand,
  Socket.io, lightweight-charts (candles, volume, MA20, 1m/5m/1h/1d), Recharts (depth, equity, allocation),
  Framer Motion (tape, panels), React Hook Form + Zod (auth). Trade terminal: watchlist with price flashes,
  live order book with depth bars + spread, depth chart, flashing trade tape, order panel (limit/market/stop/stop-limit,
  GTC/IOC/FOK, slider + 25–100%, estimated cost, exit plan with risk % and R:R, plain-English confirm dialog),
  open orders / positions with live P&L / order history. Portfolio page. Dark + light themes, mobile tabs,
  keyboard B / S / Esc, skeletons, empty and reconnecting states, persistent disclaimer.
- Verified with the full stack running (`npm run dev`): login → live Coinbase reference → bot-quoted book (≈8 bps spread)
  → market buy FILLED within 2 s → portfolio reconciles to the paisa. Screenshots in `docs/screenshots/`.
- Fixed while verifying: average fill price was shown per unit instead of per coin.
- Tests: 53 passing (engine 21, api 19, worker 8, web 5).

---

# 🎓 Mentor notes (Phases 1–4 + MVP)

### Phase 1 — Database design

**Engineering: integers for money + constraints as the last line of defence.** Floats can't represent 0.1 exactly, so
₹0.10 + ₹0.20 ≠ ₹0.30 in binary. We store paise as BIGINT and quantities as integer "units", and we chose tick sizes so
`price × qty / qty_scale` is always whole — no rounding anywhere. Then we let Postgres enforce the rules with CHECK
constraints (`cash >= 0`, `held <= cash`). Application code has bugs; constraints don't forget. If a bug ever tries to
overspend, the transaction fails instead of corrupting balances. Partitioning `trades` by day keeps each partition small,
makes old-data deletion instant (drop a partition), and lets queries for "today" skip every other day.

**Trading: virtual money, real prices.** A simulator is only useful if it feels real. We use live prices as a
_reference_, but every trade happens in our own book, so you experience real mechanics (spreads, partial fills, slippage)
without risking a rupee.

### Phase 2 — Matching engine

**Engineering: data structures + determinism.** Each side of the book is a sorted array of price levels with the best
price at the end (O(1) best bid/ask, O(1) removal of the best level) plus a hash map for O(1) level lookup. Each level is a
FIFO doubly linked list so cancels are O(1). The engine is deterministic — time comes from the command, not the clock — so
replaying the same events always rebuilds the same book. We proved the invariants with property-based tests: fast-check
generates thousands of random command sequences and checks rules (never crossed, quantities conserved, priority respected).
We mutation-tested the tests: breaking FIFO on purpose makes them fail.

**Trading: price-time priority.** The best price trades first (highest bid, lowest ask). Among equal prices, whoever
arrived first trades first. Trades happen at the _resting_ (maker) order's price, so an aggressive buyer can get a better
price than they asked for ("price improvement"). Orders can partially fill: a 5-unit buy against a 2-unit ask fills 2, and
the other 3 rest in the book.

### Phase 3 — Settlement

**Engineering: ACID + exactly-once.** Every fill moves four balances (buyer cash ↓, buyer coins ↑, seller cash ↑, seller
coins ↓). Doing that in one transaction (Atomic) means either all four change or none. We lock rows with `SELECT … FOR
UPDATE` always in the same order (accounts → holdings → orders, by id) — two transactions can't each hold what the other
wants, so no deadlocks. Exactly-once: the settler stores the last applied event number per symbol in the _same_
transaction, so a redelivered event is recognised and skipped. The invariant checker re-derives every balance from
grants + trades and compares.

**Trading: holds (pre-trade risk).** When you place a buy, the cash is reserved ("held") until the order fills or is
cancelled. That's why "available" can be lower than "cash": you can't spend the same rupee twice across open orders.

### Phase 4 — Market data & market making

**Engineering: failover and staleness.** A feed that stops sending is worse than one that disconnects — prices freeze
silently. We track the age of each source's last tick; if the primary is older than 10 s, the next fresh source wins.
Reconnects use exponential backoff with jitter so thousands of clients don't hammer a server in sync. The simulated
feed is re-anchored to every live tick, so a total outage continues smoothly instead of jumping.

**Trading: market makers and liquidity.** A market maker always shows a bid and an ask. Its profit is the spread; its risk
is _inventory_ (holding too much of something that falls). Our bots skew prices against their inventory and stop quoting
a side at their limit. Liquidity = how much you can trade without moving the price — the depth chart shows it.

### 🛠️ Your coding tasks (each has a `TODO(me)` marker — say "review my task" when done)

1. **Phase 1** — `scripts/sql/practice.sql`: rank accounts by realised P&L with `RANK()`, then read the `EXPLAIN ANALYZE`.
2. **Phase 2** — `apps/engine/src/book/order-book.ts`: add `maxOrderQty` fat-finger protection + a unit test.
3. **Phase 3** — `apps/api/src/trading/invariants.ts`: add the "no-stuck-pending-orders" invariant + make a test prove it.
4. **Phase 4** — `apps/worker/test/market.test.ts`: parser tests for the three exchange adapters.

### ❓ Quiz

1. (P1) Why does `trades` need `executed_at` inside its primary key?
2. (P1) What does a BRIN index store, and why is it tiny compared with a B-tree on the same column?
3. (P2) A resting ask of 2 @ ₹100 and 3 @ ₹101 exist. A limit buy for 4 @ ₹101 arrives. List the fills and what's left.
4. (P2) Why does reducing an order's quantity keep its queue position but raising it does not?
5. (P3) Two settlers lock accounts 7 then 3, and 3 then 7. What can happen, and how does our code prevent it?
6. (P3) Why is the event offset updated in the _same_ transaction as the balances — what breaks if it's a separate step?
7. (P4) Why do we cap a market order with a "protection price"?
8. (P4) If a market maker keeps getting filled on its bids while the price falls, what happens to its inventory, and what does our bot do about it?

---

## Phase 5 + 6 — Candle history, equity snapshots, materialized views ✅

Worker jobs roll trades up into `candles` (1m/5m/1h/1d) with window functions, take equity snapshots every 5 minutes,
and refresh the leaderboard views every 10 s. All six instruments are live; the seed adds 14 days of candle history
that ends exactly at today's price.

## Phase 7 — Trade Coach, competitions, admin, learn ✅

- **Trade Coach** (`packages/shared/src/coach.ts`, `apps/api/src/coach/coach.ts`, `/coach`): round trips, process grades
  A–F, 13 flags, tips, weekly Skill Score, 6 badges.
- **Competitions** (`/compete`): admin-created, fresh wallet per joiner, live leaderboard from `mv_leaderboard`, a
  wallet switcher in the header; orders are refused outside the competition window.
- **Admin** (`/admin`): health of every service, engine → settlement → coach lag per symbol, halt/resume through the
  engine, bots, create competitions, run the ledger check.
- **Learn** (`/learn`): 7 lessons on the live market with an order preview and a risk-based position-size calculator.
- **Demo data**: Asha (disciplined), Rahul (impulsive, improving), Meera (mixed) with 2 weeks of graded history;
  `npm run demo:traders` makes 8 demo competitors trade for real.

## Phase 8 — Proof, tooling, docs ✅

- `npm run load:test`: 245 orders/s at 100 users, ~285 orders/s ceiling at 300 users on this laptop; insert → settled
  p50 19–28 ms; 0 lost; invariants hold.
- Playwright e2e (5 tests, Edge locally), GitHub Actions CI (not yet run on GitHub — no remote), docker-compose
  (untested here — Docker isn't installed), README, DATABASE, TRADING_BASICS, INTERVIEW_NOTES, DEPLOY.

---

# 🎓 Mentor notes (Phases 5–8)

### Phase 5 + 6 — Materialized views and window functions

**Engineering.** A leaderboard needs every account's equity — cash plus every holding at today's price — ranked. Doing
that on every request means aggregating accounts × holdings × prices each time. A **materialized view** stores the result
like a table; the worker refreshes it every 10 s. `REFRESH … CONCURRENTLY` builds the new version alongside the old one
and swaps it in, so readers never wait — it needs a UNIQUE index to match old rows to new. Ranking uses a **window
function**: `RANK() OVER (PARTITION BY competition_id ORDER BY return DESC)` ranks within each competition without
collapsing rows like GROUP BY would. Candles use window functions too: `first_value(price)` is the open,
`last_value(price)` the close, per time bucket. The trade-off is staleness — fine for a leaderboard, never for a balance.

**Trading.** Ranking by **return %**, not rupees, is only fair because every competitor starts with the same cash —
that's why each competition gets a fresh wallet.

### Phase 7 — The Trade Coach

**Engineering.** The coach is a separate consumer of settled trades, so settlement stays fast and coaching can't break
balances. It replays trades per symbol in engine sequence order (one settler per symbol commits in order, so that order
is also visibility order) and keeps each user's open position. Its cursor, positions and graded trips commit in **one
transaction** — the same exactly-once pattern as settlement. The grading itself is a **pure function** (facts in, grade
out), so it's trivial to unit-test and the same function grades live and demo trips.

**Trading.** Grade the **process, not the outcome**. With a planned stop, size is judged by the money at risk if the stop
is hit — risking 1% with a 2% stop allows a 50% position. Without a stop, the whole position is at risk. Revenge trading
(bigger trade right after a loss), FOMO (buying a spike) and holding losers are how small losses become big ones.

### Phase 8 — Measuring honestly

**Engineering.** Two benchmarks answer two questions. The engine benchmark (423k commands/s) says "matching is not the
problem". The load test says what the _system_ does: ~285 orders/s before the single API process saturates, while
matching + settlement stay at ~20–30 ms. When throughput stops rising but latency climbs, you've found the bottleneck —
requests are queueing. Volume also finds bugs that unit tests can't: at 60k orders a correlated subquery in the ledger
check turned an instant query into a 2-minute one (fixed with a grouped join). Always state the machine and conditions
next to a number.

**Trading.** Liquidity has limits too: the bots quote finite size at each level, which is why large market orders slip.

### 🛠️ Your new coding tasks (`TODO(me)` markers — say "review my task" when done)

5. **Phase 7** — `packages/shared/src/coach.ts`: add a `QUICK_FLIP` habit (round trip held < 1 minute) + tests.
6. **Phase 7** — `apps/api/src/routes/competitions.ts`: `?sort=process` leaderboard by average process score + a test.
7. **Phase 7** — `apps/web/src/features/learn/LearnPage.tsx`: lesson 8 "Stop-market vs stop-limit".
8. **Phase 8** — `e2e/tradecore.spec.ts`: an e2e test for the Learn page's risk calculator.

(Tasks 1–4 from Phases 1–4 are still open, listed above.)

### ❓ Quiz (Phases 5–8)

9. (P5) Why does `REFRESH MATERIALIZED VIEW CONCURRENTLY` need a unique index, and what do readers see during it?
10. (P6) What's the difference between `RANK()` and `ROW_NUMBER()` when two traders have the same return?
11. (P7) Why can a losing trade earn an A? Give the flags it would need.
12. (P7) The coach reads trades by engine `seq`, not by `trades.id`. What could go wrong with `id` across symbols?
13. (P7) Risk 1% of ₹1,00,000 with entry ₹200 and stop ₹190. How many shares, and what % of your money is the position?
14. (P8) In the load test, users went 100 → 300 and throughput only went 245 → 285 orders/s. What does that tell you, and
    where would you look first?
15. (P8) Why is BRIN a good fit for `trades.executed_at` but a bad fit for `trades.buyer_account_id`?
16. (P8) Why do the CI tests use the simulated price feed instead of Coinbase?
