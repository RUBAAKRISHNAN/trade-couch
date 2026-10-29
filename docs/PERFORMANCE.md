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

What this means: the in-memory matching logic is not the bottleneck; end-to-end throughput is bounded by Redis
round trips and Postgres settlement (see the load test, coming in Phase 8).

## End-to-end — `npm run load:test`

_Phase 8._
