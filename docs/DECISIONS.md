# Architecture Decision Log

Short records of the important choices and _why_. Newest at the bottom.

## D1 — Pinned dependency majors

Latest majors at build time (Oct 2026) included TypeScript 7 (native port), Prisma 8 RC, Zod 4 and Vite 8.
We pin well-understood majors: **TypeScript 5.9, Prisma 6, Zod 3, Vite 7, Vitest 3, ESLint 9, React Router 7,
ioredis 5, BullMQ 5**. Reason: typescript-eslint and other tooling lag new TS majors, and a portfolio project
should favour stable, documented APIs. Upgrading is a separate, testable task.

## D2 — Money and quantity are integers

Money is `BIGINT` paise; quantity is `BIGINT` units with a per-instrument `qty_scale`
(BTC: 1 unit = 0.0001 BTC). A CHECK enforces `tick_size_paise % qty_scale = 0`, so
`price × qty / qty_scale` is always a whole number of paise: no rounding anywhere in settlement.
In JS we use `number` and assert `Number.isSafeInteger` (limit ≈ ₹90 lakh crore). The `pg` driver is configured
to parse int8 to number and throw if a value would exceed the safe range.

## D3 — Separate account per competition

`accounts(user_id, competition_id)` with `UNIQUE NULLS NOT DISTINCT`. `competition_id IS NULL` is the main
practice account. Every contest participant starts with identical cash, so leaderboards are fair.

## D4 — Order book: sorted array + map, FIFO linked lists

Each side keeps price keys in a sorted array (best price at the END) and a `Map<price, level>`.
Best bid/ask is O(1), removing the best level is O(1) (`pop`), finding a level is O(1) via the map,
and creating a new level is an O(log n) binary search plus a splice. New levels almost always appear
near the top of book (the end of the array), so the splice moves very little memory. A red-black tree gives
guaranteed O(log n) inserts but worse constants and cache behaviour at the level counts we see (tens to low thousands).
Each level is a doubly linked list: O(1) append, O(1) match from head, O(1) cancel from the middle.

## D5 — Market orders carry a protection price

A pure market order has unbounded cost, so it cannot be pre-funded. The API attaches a
**protection price** = reference ± the instrument's price band, and holds cash against it. The engine
treats it as the worst acceptable price (an IOC limit). The same applies to stop-market orders (protection
from the stop price). Many real exchanges do this ("market with protection").

## D6 — Self-trade prevention: cancel newest

When an incoming order would match the same account's resting order, the incoming remainder is cancelled
and the resting order is untouched. Simple, predictable, and keeps bots from trading with themselves.

## D7 — Stops trigger on last trade OR reference (mark) price

Our exchange only trades when users trade, so the last trade price can go stale while the real market moves.
Stops therefore trigger when _either_ the last traded price or the reference price reaches the stop.

## D8 — Event sourcing via output events; idempotent commands

The engine is deterministic (time comes from the command, not the clock). Every state change is an event with
a gap-free per-symbol `seq`. `OrderBook.apply(event)` rebuilds state from the log; a property test proves replay of
any prefix equals the live book at that point. Redelivered NEW commands (same order id) are ignored.

## D9 — Raw SQL migrations own the schema; Prisma maps a subset

Partitioning, triggers, BRIN indexes, `NULLS NOT DISTINCT` and materialized views are outside Prisma's
migration DSL. A tiny forward-only runner (`scripts/db-migrate.ts`) applies `db/migrations/*.sql` in a
transaction each. `db/prisma/schema.prisma` maps only CRUD tables (users, tokens, instruments, competitions,
bots, badges, settings). Hot paths (orders, settlement, analytics) use `pg` with hand-written SQL.

## D10 — Exactly-once settlement via `engine_offsets`

The settler applies event `seq = N` for a symbol only if `engine_offsets.last_seq = N - 1`, updating the
offset **in the same transaction** as the balance changes. A redelivered event is detected and skipped;
a gap stops the settler loudly. This beats a unique constraint alone because partitioned unique keys must
include the partition column.

## D11 — Second live feed: Binance (Kraken blocked on the dev network)

Kraken's WebSocket and REST endpoints are unreachable from the development network (non-101 / no connection),
so `BinanceFeed` (public `data-stream.binance.vision`, USDT pairs, 1 USDT ≈ 1 USD) is the second live source.
The Kraken adapter stays (it works on other networks). Failover order: coinbase → binance → kraken → simulated.

## D12 — Known dependency advisories (reviewed Oct 2026)

- `@fastify/static` (via Swagger UI): **fixed** by upgrading `@fastify/swagger-ui` to 6.1.2.
- `zod` 3.x memory exhaustion on oversized constrained collections (GHSA-mrhx-c7xc-m3w5): exposure is limited
  (Fastify's 1 MB body limit; no unbounded arrays in our schemas). Fix = Zod 4 + fastify-type-provider-zod 7;
  planned as a dedicated upgrade.
- `prisma` 6 CLI → `deepmerge-ts`: build-time code generation only, not reachable at runtime. Upgrade with Prisma 7.

## D13 — Trade Coach reads settled trades, not settlement internals

The coach is a separate worker job that replays `trades` per symbol in engine `seq` order (one settler per symbol
commits batches in sequence, so seq order = visibility order). Its cursor, the open positions it tracks and the round
trips it grades are written in **one transaction**, so each trade is coached exactly once and a crash just retries the
batch. Settlement stays small and fast; coaching can lag a few seconds without affecting balances. A global trade-id
cursor was rejected: ids are assigned at insert but committed later across symbols, so a reader could skip a trade.

## D14 — Coach grades process, not outcome; size by risk to the stop

Grades come from flags with fixed points (base 60, clamp 0–100: A ≥ 85 … F < 40). Profit is deliberately absent. With a
planned stop, position size is judged by the % of equity lost if the stop is hit (≤ 1% small, > 2% large, > 5% very
large) — the textbook "risk 1% per trade" rule, under which a 50% position with a 2% stop is fine. Without a stop the
whole position is at risk, so its value is used (≤ 5% / > 10% / > 25%). The first version only used position value and
graded a correct 1%-risk trade as "all-in"; writing the Learn page's sizing calculator exposed the contradiction.

## D15 — Leaderboards from materialized views; admins and bots never rank

`mv_portfolio_summary` (equity per human account) → `mv_leaderboard` (`RANK() OVER (PARTITION BY competition_id ORDER BY
return)`), refreshed `CONCURRENTLY` every 10 s (needs a UNIQUE index; readers never block). Ranking by return % is fair
because everyone in a group starts with the same cash. Staleness of ≤ 10 s is acceptable for a leaderboard and turns a
per-request aggregation into an index lookup. Admin accounts are excluded (migration 0007, found by a test).

## D16 — Demo data is labelled, never faked into the ledger

Seeded coach history (`round_trips.source = 'seed'`) has no trades behind it and is shown as "Demo history"; it is graded
by the same `recordTrip` code as live trips. Competition standings are never seeded: `npm run demo:traders` makes demo
competitors place real orders through the normal path. Ledger invariants therefore always hold on seeded databases.

## D17 — Halt/resume is an engine command

Halting writes a `HALT` command to the symbol's stream instead of flipping a DB flag, so it is ordered with every other
command: orders queued before the halt are processed, later ones are rejected by the engine itself. Settlement records
the status from the engine's `HALTED` event. The API's 1-second instrument cache is invalidated on the node that sent
the command; other nodes catch up within a second, and the engine rejects regardless.

## D18 — Load accounts use the BOT role

`npm run load:test` creates its users with role BOT, which keeps them out of leaderboards and the Trade Coach while still
exercising the full order path. They remain in the dev database (they are real ledger participants).

## D19 — Lost orders: reaper + order TTL instead of a full outbox

Placing an order commits the order and its hold in Postgres, then adds the command to Redis. A crash between the two
leaves the order PENDING forever with its money reserved (seen for real when a dev server was killed mid-startup). A
transactional outbox would remove the gap, at the cost of a relay process and extra latency on every order. Instead:

- The engine rejects NEW orders that reach it more than `NEW_ORDER_TTL_MS` (30 s) after being placed (`STALE`). This is
  good behaviour on its own: a minute-old market order shouldn't fill at a new price.
- A worker job (`reapLostOrders`, every 30 s) rejects orders that are PENDING after `LOST_ORDER_AFTER_MS` (60 s) with no
  engine events — but only when the engine's consumer group has nothing pending (lag 0), a heartbeat taken afterwards
  shows a seq settlement has reached, so a command that was ever sent would have left events. Any late command is
  older than the TTL and gets rejected by the engine, so a reaped order can never be matched.
- `failPendingOrder` now re-reads the order under its row lock (it used values read before locking).

## D20 — Separate rate-limit buckets for login and session refresh

Login and register keep 20 / minute per IP to slow password guessing. `/auth/refresh` (runs on every page load; needs a
256-bit random token, so it can't be brute-forced) has its own 120 / minute bucket. Sharing one bucket locked users out
of logging in during normal browsing — worst in development, where every local tab comes through the Vite proxy as
127.0.0.1.
