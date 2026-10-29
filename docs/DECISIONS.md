# Architecture Decision Log

Short records of the important choices and *why*. Newest at the bottom.

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
Stops therefore trigger when *either* the last traded price or the reference price reaches the stop.

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
