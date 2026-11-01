-- Index before/after measurements for docs/DATABASE.md. Non-destructive: drops happen inside BEGIN … ROLLBACK,
-- the 2M-row table is TEMP (session only). Run:  psql -d tradecore -v acct=<an account id> -f scripts/sql/explain-indexes.sql
\pset pager off
\echo '=== 1a my trades WITH indexes'
EXPLAIN (ANALYZE, COSTS OFF) SELECT * FROM trades WHERE buyer_account_id = :acct OR seller_account_id = :acct ORDER BY executed_at DESC LIMIT 100;
BEGIN; DROP INDEX trades_buyer_idx; DROP INDEX trades_seller_idx;
\echo '=== 1b my trades WITHOUT indexes'
EXPLAIN (ANALYZE, COSTS OFF) SELECT * FROM trades WHERE buyer_account_id = :acct OR seller_account_id = :acct ORDER BY executed_at DESC LIMIT 100;
ROLLBACK;
\echo '=== 2a open orders WITH partial index'
EXPLAIN (ANALYZE, COSTS OFF) SELECT * FROM orders WHERE account_id = :acct AND symbol = 'BTC-INR' AND status IN ('PENDING','OPEN','PARTIALLY_FILLED');
BEGIN; DROP INDEX orders_open_idx; DROP INDEX orders_account_time_idx;
\echo '=== 2b open orders WITHOUT'
EXPLAIN (ANALYZE, COSTS OFF) SELECT * FROM orders WHERE account_id = :acct AND symbol = 'BTC-INR' AND status IN ('PENDING','OPEN','PARTIALLY_FILLED');
ROLLBACK;
\echo '=== 3 synthetic 2,000,000-row trades table (temp, session only)'
CREATE TEMP TABLE big AS
  SELECT g AS id, (g % 5000) + 1 AS account_id, timestamptz '2026-10-01' + g * interval '1 second' AS executed_at, (random() * 1000)::int AS qty
  FROM generate_series(1, 2000000) g;
ANALYZE big;
\echo '=== 3a account lookup, no index'
EXPLAIN (ANALYZE, COSTS OFF) SELECT * FROM big WHERE account_id = 4242 ORDER BY executed_at DESC LIMIT 100;
CREATE INDEX big_acct ON big (account_id, executed_at DESC);
\echo '=== 3b account lookup, composite B-tree (account_id, executed_at DESC)'
EXPLAIN (ANALYZE, COSTS OFF) SELECT * FROM big WHERE account_id = 4242 ORDER BY executed_at DESC LIMIT 100;
\echo '=== 3c time range, no index'
EXPLAIN (ANALYZE, COSTS OFF) SELECT count(*) FROM big WHERE executed_at BETWEEN timestamptz '2026-10-10' AND timestamptz '2026-10-10 01:00';
CREATE INDEX big_brin ON big USING brin (executed_at);
\echo '=== 3d time range, BRIN'
EXPLAIN (ANALYZE, COSTS OFF) SELECT count(*) FROM big WHERE executed_at BETWEEN timestamptz '2026-10-10' AND timestamptz '2026-10-10 01:00';
CREATE INDEX big_btree_time ON big (executed_at);
SELECT pg_size_pretty(pg_relation_size('big')) AS table_size, pg_size_pretty(pg_relation_size('big_brin')) AS brin_size, pg_size_pretty(pg_relation_size('big_btree_time')) AS btree_size;
