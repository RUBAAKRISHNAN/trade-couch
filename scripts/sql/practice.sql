-- Practice queries (not run by migrations). Run with: psql -d tradecore -f scripts/sql/practice.sql

-- TODO(me) [Phase 1 task, ~30 min]: write a query that ranks every non-bot account by total REALISED P&L
--   (holdings.realized_pnl_paise summed per account) using RANK() OVER (ORDER BY … DESC).
--   Show display_name, total realised P&L in rupees, and rank. Two accounts with the same P&L must share a rank.
--   Then run it with EXPLAIN (ANALYZE, BUFFERS) and write in a comment: which join strategy did Postgres pick, and why?
--   Hint: users → accounts → holdings; filter users.role <> 'BOT'.
