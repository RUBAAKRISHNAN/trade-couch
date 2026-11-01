# Interview notes

Twenty questions an interviewer is likely to ask about TradeCore, answered in plain English. Practise saying them out
loud **without reading**. Every number here was measured on this project — see [PERFORMANCE.md](PERFORMANCE.md).

---

### 1. What is TradeCore, in one minute?

A trading simulator for beginners. Users get ₹1,00,000 of virtual money and trade on real live prices, but every trade
is matched by my own exchange: an order book, a matching engine and settlement into PostgreSQL. On top of that, a Trade
Coach grades each finished trade on _process_ — stop-loss, position size, habits like revenge trading — not on profit,
because most beginners lose money through bad risk habits, not bad picks. There are also competitions with live
leaderboards and an admin view of the whole pipeline.

### 2. Walk me through what happens when someone places an order.

The API validates it (Zod), checks pre-trade risk and **reserves** the cash or coins in one Postgres transaction so they
can't be spent twice, then appends a command to that symbol's Redis stream. The matching engine — one single-threaded
loop per symbol — matches it by price-time priority and emits events (accepted, trade, cancelled). A settler reads those
events and, in one ACID transaction, moves cash and coins for both sides, writes the trade row and advances an offset.
The result is pushed to browsers over WebSockets. Median time from insert to settled: ~20 ms under load.

### 3. How does the matching engine work? What data structures?

Each side of the book is a sorted array of price levels with the best price at the end, plus a hash map from price to
level, so best bid/ask is O(1) and finding a level is O(1). Each level is a FIFO doubly linked list, so time priority is
natural and cancels are O(1). New price levels are inserted with binary search, O(log n). It's deterministic: time comes
from the command, not the clock, so replaying the same events rebuilds the identical book. Engine-only benchmark:
~423,000 commands/sec, p99 6.8 µs.

### 4. Why one thread per symbol?

Orders in one symbol must be processed in a strict order — that's what makes matching fair. A single thread per symbol
gives that ordering with no locks. Different symbols don't interact, so they scale across processes. Real exchanges
shard by symbol the same way.

### 5. How do you guarantee nobody can spend the same money twice?

Three layers. First, **holds**: placing an order reserves the cash inside a transaction that locks the account row, so
50 parallel orders can't each see the same balance. Second, **CHECK constraints** in Postgres (`cash >= 0`,
`held <= cash`) reject any write that would break the rule, even from buggy code. Third, an **invariant checker** that
re-derives every balance from grants plus trades and compares. A test fires 20 parallel orders at an account that can
afford 10: exactly 10 succeed.

### 6. What does "exactly-once settlement" mean and how did you do it?

Each engine event has a sequence number per symbol. The settler stores the last applied number in `engine_offsets` and
updates it **in the same transaction** as the balances. If an event is delivered twice (a crash and retry), the settler
sees it's already applied and skips it. If the offset were saved separately, a crash between the two steps would either
apply a fill twice or lose it.

### 7. How do you avoid deadlocks?

Every settlement transaction locks rows in the same global order: accounts by id, then holdings, then orders. Deadlocks
need a cycle — A waits for B while B waits for A — and a fixed lock order makes a cycle impossible.

### 8. Why READ COMMITTED and not SERIALIZABLE?

Because every row we modify is explicitly locked with `SELECT … FOR UPDATE` first, there are no lost updates.
SERIALIZABLE would add serialization failures and retries on exactly the hottest rows, for no extra safety here.

### 9. Why store money as integers?

Floats can't represent 0.1 exactly, so ₹0.10 + ₹0.20 isn't ₹0.30. I store paise as BIGINT and quantities as integer
units, and chose tick sizes so price × quantity ÷ scale is always a whole number of paise. Nothing ever rounds.

### 10. What is event sourcing here, and why use it?

The engine's events are appended to an `order_events` log. The `orders` table is just a fast projection of it. After a
crash, the engine rebuilds its in-memory book by replaying the log. Property tests check that replaying any random
sequence of commands gives an identical book.

### 11. How did you test the matching engine?

Unit tests for specific cases, plus **property-based tests** with fast-check: it generates thousands of random command
sequences and checks rules that must always hold — the book is never crossed, quantity and cash are conserved,
price-time priority is respected, replay matches. I also broke the FIFO rule on purpose to make sure the tests catch it.

### 12. How does the Trade Coach work?

A worker replays settled trades per symbol, in sequence order, and tracks each user's position. When a position goes
back to zero, that's a "round trip". It gathers facts from the database — was there a stop, how big was the risk, how far
had the price just moved, was the last trade a loss 10 minutes ago — and a pure function turns them into flags with
points, a score and an A–F grade, plus one tip aimed at the costliest mistake. The cursor, open positions and grades are
written in one transaction, so each trade is coached once. Weekly Skill Scores and badges are SQL aggregates.

### 13. Why grade process instead of profit?

Because profit is noisy: a reckless all-in trade can win by luck and a perfect trade can lose. If you reward outcomes,
you teach gambling. The Coach rewards what works over many trades: small risk, a planned stop, a good risk:reward, and
avoiding emotional patterns.

### 14. Tell me about a bug you found.

Two good ones. (1) The Coach originally judged size by position value, so a textbook trade — risk 1% with a 2% stop,
which means a 50% position — was graded "all-in". Building the Learn page's sizing calculator exposed the
contradiction; now, with a planned stop, it grades the money at risk to the stop. (2) The load test grew the data to 60k
orders and the ledger check went from instant to 2 minutes 12 seconds: one check ran a subquery per order that scanned
all trades. Rewritten as one grouped join it takes about 4 seconds with identical results.

### 15. How do the leaderboards work?

A materialized view computes each account's equity at the latest price; a second ranks them with
`RANK() OVER (PARTITION BY competition ORDER BY return DESC)`. The worker refreshes both every 10 seconds with
`REFRESH … CONCURRENTLY`, which needs a unique index and never blocks readers. A leaderboard read becomes an index lookup.
The trade-off is up to 10 seconds of staleness, which is fine for a leaderboard.

### 16. Which indexes did you add and how did you know they helped?

I measured with `EXPLAIN ANALYZE`, dropping indexes inside a rolled-back transaction. A **partial index** on open
orders only contains live orders: 2.2 ms → 0.06 ms. On a 2-million-row table, a **composite B-tree**
`(account_id, executed_at DESC)` took an account lookup from 291 ms to 1.2 ms, and a **BRIN** index on time took a
one-hour range from 366 ms to 5.6 ms while being 24 kB instead of 43 MB for a B-tree — BRIN only stores min/max per
block, which works because trades arrive in time order.

### 17. Why partition the trades table?

By day: queries for recent data only touch today's partition, and old data can be dropped instantly. The costs: unique
keys must include the time column, and planning a query across many partitions is slower — I saw 329 ms planning versus
3 ms execution for a "last hour" query, because pruning happened at run time.

### 18. What's the bottleneck, and how would you scale it?

Measured: one API process saturates around 285 orders/sec on my 4-core laptop (with the load generator, Postgres and
Redis on the same machine). Matching and settlement stay at ~20–30 ms. To scale: run several API processes behind a load
balancer — rate limits, WebSocket fan-out (Redis adapter) and leaderboards are already shared, so that works today —
batch the pre-trade hold writes, and shard engines across machines by symbol.

### 19. How do live prices and failover work?

Market-data adapters for Coinbase, Binance and Kraken WebSockets, plus a simulated feed. If the primary source's last
tick is older than 10 seconds, the next fresh one takes over; reconnects use exponential backoff with jitter. If every
live feed is down, the simulated feed continues from the last real price, so the market never freezes. Kraken was blocked
on my network, which is why Binance was added.

### 20. What would you do differently, or next?

Bundle the server for production instead of running TypeScript directly; refresh tokens are already in httpOnly cookies,
but I'd add CSRF protection for cookie endpoints; an outbox table so notifications are guaranteed; and real-time
leaderboards via incremental updates instead of a full refresh once there are many users. Honestly, I'd also deploy it
earlier — real users find different bugs than tests do.
