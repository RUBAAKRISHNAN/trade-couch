-- Trade Coach state.
-- The coach worker reads settled trades per symbol, in engine sequence order, and turns each account's
-- buys and sells into round trips (flat → position → flat). Its cursor and the open positions it is
-- tracking advance in the SAME transaction as the round trips it writes, so every trade is coached once.

CREATE TABLE coach_cursors (
  symbol     text PRIMARY KEY REFERENCES instruments(symbol),
  last_seq   bigint NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The round trip currently open per (account, symbol). Deleted when the position goes back to flat.
CREATE TABLE coach_positions (
  account_id      bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  symbol          text NOT NULL REFERENCES instruments(symbol),
  qty_units       bigint NOT NULL CHECK (qty_units > 0),
  opened_at       timestamptz NOT NULL,
  buy_units       bigint NOT NULL CHECK (buy_units > 0),
  buy_notional    bigint NOT NULL CHECK (buy_notional >= 0),
  sell_units      bigint NOT NULL DEFAULT 0 CHECK (sell_units >= 0),
  sell_notional   bigint NOT NULL DEFAULT 0 CHECK (sell_notional >= 0),
  entry_order_ids bigint[] NOT NULL DEFAULT '{}',
  exit_order_ids  bigint[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (account_id, symbol)
);

-- 'live' round trips come from real trades; 'seed' ones are demo history (no trades behind them).
ALTER TABLE round_trips ADD COLUMN source text NOT NULL DEFAULT 'live' CHECK (source IN ('live', 'seed'));

-- Week-level "habit" flags are kept per round trip in coach_reports.flags; this index serves the weekly roll-up.
CREATE INDEX coach_reports_flags_gin ON coach_reports USING gin (flags);

INSERT INTO badges (code, name, description, icon) VALUES
  ('FIRST_TRIP',   'First round trip', 'Closed your first trade from entry to exit.', 'flag'),
  ('STOP_10',      'Safety first',     'Used a stop-loss on 10 round trips.', 'shield'),
  ('SMALL_RISK_10','Small bets',       'Kept 10 round trips at 5% of your money or less.', 'scale'),
  ('A_GRADE_5',    'Straight A''s',    'Earned an A grade on 5 round trips.', 'star'),
  ('PLAN_5',       'Plan the trade',   'Followed your own exit plan on 5 round trips.', 'target'),
  ('STEADY_WEEK',  'Steady week',      'A week with 5+ round trips and a Skill Score of 80 or more.', 'trophy')
ON CONFLICT (code) DO NOTHING;
