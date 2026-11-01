# Performance

All numbers are measured, not estimated. Re-run them yourself; results vary by machine and background load.

**Machine:** AMD Ryzen 3 7320U (4 cores / 8 threads, laptop), 7.2 GB RAM, Windows 11 (10.0.26200), Node v22.17.0,
PostgreSQL 17.11 (local), Memurai (Redis-compatible, local).

## Matching engine only — `npm run bench:engine`

Single thread, one symbol, no I/O. 1,000,000 pre-generated commands (70% limit orders within ±50 ticks of mid,
20% cancels, 10% market orders), 50k-command warm-up.

| Metric                    | Result                             |
| ------------------------- | ---------------------------------- |
| Throughput                | **≈ 423,000 commands/sec**         |
| Latency p50 / p99 / p99.9 | **1.5 µs / 6.8 µs / 30.6 µs**      |
| Max                       | 52 ms (a garbage-collection pause) |
| Trades produced           | 311,893                            |
| Resting orders at end     | 339,228 across 77 price levels     |

What this means: the in-memory matching logic is not the bottleneck; end-to-end throughput is bounded by the API
process and Postgres (see the load test below).

## End-to-end — `npm run load:test`

Real HTTP against the running app (`npm run dev`): JWT auth → Zod validation → pre-trade risk hold (a Postgres
transaction) → Redis stream → engine → settlement transaction. 60% market / 40% marketable limit orders on BTC-INR,
1 lot each, against the market-maker bots. **The load generator runs on the same laptop as all four services, Postgres
and Memurai**, so they compete for the same 4 cores — numbers on a real server would be higher. The API is a single
Node process. Each user is limited to 30 orders / 10 s by the API's rate limiter, so more users = more load.

| Run              | Orders accepted           | HTTP p50 / p95 / p99   | Insert → settled p50 / p95 / p99 | Lost / stuck | Invariants |
| ---------------- | ------------------------- | ---------------------- | -------------------------------- | ------------ | ---------- |
| 100 users × 60 s | 14,764 → **245 orders/s** | 40 / 163 / 326 ms      | **19 / 44 / 71 ms**              | 0 / 0        | all hold ✓ |
| 300 users × 45 s | 13,042 → **285 orders/s** | 565 / 1,472 / 2,569 ms | 28 / 63 / 388 ms                 | 0 / 0        | all hold ✓ |

What this means:

- **~285 orders/s is this machine's ceiling for one API process.** Tripling the users added only 16% throughput while
  HTTP latency rose ~14× — requests were queueing in the API.
- **Matching + settlement stay fast under saturation**: an order is matched and its balances settled ~20–30 ms (median)
  after the API inserts it. The engine benchmark (423k commands/s) shows matching itself is never the limit.
- **Correctness under load**: every one of the 27,806 orders reached a final state, nothing was refused unexpectedly,
  and all eight ledger invariants held afterwards.
- Next steps to scale: run several API processes behind a load balancer (the design already allows it: rate limits,
  websockets and leaderboards are shared through Redis/Postgres), and batch the pre-trade hold writes.

## Ledger invariant check

`npm run check:invariants` on the dev database after the load tests (~60k orders, ~30k trades): the
"fills-settled-exactly-once" check originally used a correlated subquery per order (an N × M scan) and took **2 min
12 s**; rewritten as one grouped join it takes **~4 s** (7 s including process start-up), with identical results.

## Indexes — see [DATABASE.md](DATABASE.md)

`EXPLAIN ANALYZE` before/after for the partial "open orders" index, a composite B-tree and BRIN on a 2-million-row
table.
