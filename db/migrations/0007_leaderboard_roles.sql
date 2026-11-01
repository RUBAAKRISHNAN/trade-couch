-- Admins operate the platform; they shouldn't appear in rankings. mv_portfolio_summary keeps every
-- human account (equity snapshots use it) and now carries the role, so the leaderboard can filter on it.
DROP MATERIALIZED VIEW mv_leaderboard;
DROP MATERIALIZED VIEW mv_portfolio_summary;

CREATE MATERIALIZED VIEW mv_portfolio_summary AS
SELECT a.id                  AS account_id,
       a.user_id,
       a.competition_id,
       u.display_name,
       u.role,
       a.cash_paise,
       a.starting_cash_paise,
       COALESCE(v.market_value, 0)::bigint                AS market_value_paise,
       (a.cash_paise + COALESCE(v.market_value, 0))::bigint AS equity_paise,
       COALESCE(rt.trips, 0)::int                          AS round_trips,
       rt.avg_score::int                                   AS avg_process_score,
       now()                                               AS refreshed_at
FROM accounts a
JOIN users u ON u.id = a.user_id
LEFT JOIN LATERAL (
  SELECT SUM(h.qty_units * COALESCE(mp.ref_price_paise, mp.last_price_paise, 0) / i.qty_scale) AS market_value
  FROM holdings h
  JOIN instruments i ON i.symbol = h.symbol
  LEFT JOIN market_prices mp ON mp.symbol = h.symbol
  WHERE h.account_id = a.id AND h.qty_units > 0
) v ON true
LEFT JOIN LATERAL (
  SELECT count(*) AS trips, round(avg(c.score)) AS avg_score
  FROM round_trips r JOIN coach_reports c ON c.round_trip_id = r.id
  WHERE r.account_id = a.id
) rt ON true
WHERE u.role <> 'BOT';

CREATE UNIQUE INDEX mv_portfolio_summary_pk ON mv_portfolio_summary (account_id);

CREATE MATERIALIZED VIEW mv_leaderboard AS
SELECT s.account_id,
       s.user_id,
       s.competition_id,
       s.display_name,
       s.equity_paise,
       s.starting_cash_paise,
       s.equity_paise - s.starting_cash_paise AS pnl_paise,
       round((s.equity_paise - s.starting_cash_paise)::numeric * 100 / s.starting_cash_paise, 4) AS return_pct,
       s.round_trips,
       s.avg_process_score,
       RANK() OVER (PARTITION BY s.competition_id
                    ORDER BY (s.equity_paise - s.starting_cash_paise)::numeric / s.starting_cash_paise DESC) AS rank,
       count(*) OVER (PARTITION BY s.competition_id) AS participants,
       s.refreshed_at
FROM mv_portfolio_summary s
WHERE s.role = 'USER';

CREATE UNIQUE INDEX mv_leaderboard_pk ON mv_leaderboard (account_id);
CREATE INDEX mv_leaderboard_rank_idx ON mv_leaderboard (competition_id, rank);
