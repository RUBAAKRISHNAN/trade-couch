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
