-- TradeCore schema v1.
-- Money: BIGINT paise. Quantity: BIGINT units (instrument.qty_scale units = 1 coin/share). Never floats.

CREATE EXTENSION IF NOT EXISTS citext;

-- ───────────────────────────── users & auth ─────────────────────────────
CREATE TYPE user_role AS ENUM ('USER', 'ADMIN', 'BOT');

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext NOT NULL UNIQUE,
  password_hash text NOT NULL,
  display_name  text NOT NULL CHECK (length(display_name) BETWEEN 2 AND 40),
  role          user_role NOT NULL DEFAULT 'USER',
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Rotating refresh tokens. Each login starts a "family"; every refresh replaces the token.
-- If an already-replaced token is presented again (reuse = likely theft), the whole family is revoked.
CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id   uuid NOT NULL,
  token_hash  text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  replaced_by uuid REFERENCES refresh_tokens(id)
);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);

-- ───────────────────────────── instruments ─────────────────────────────
CREATE TYPE instrument_kind AS ENUM ('LIVE_CRYPTO', 'SIMULATED');
CREATE TYPE instrument_status AS ENUM ('ACTIVE', 'HALTED', 'DISABLED');

CREATE TABLE instruments (
  symbol          text PRIMARY KEY CHECK (symbol ~ '^[A-Z0-9-]{2,32}$'),
  name            text NOT NULL,
  kind            instrument_kind NOT NULL,
  tick_size_paise bigint NOT NULL CHECK (tick_size_paise > 0),
  lot_size_units  bigint NOT NULL CHECK (lot_size_units > 0),
  qty_scale       bigint NOT NULL CHECK (qty_scale > 0),
  price_band_bps  integer NOT NULL CHECK (price_band_bps BETWEEN 1 AND 5000),
  status          instrument_status NOT NULL DEFAULT 'ACTIVE',
  feed            jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- guarantees price × qty / qty_scale is always a whole number of paise
  CONSTRAINT tick_divisible_by_scale CHECK (tick_size_paise % qty_scale = 0)
);

-- Latest reference + last traded price per symbol (one row each), used for valuations.
CREATE TABLE market_prices (
  symbol          text PRIMARY KEY REFERENCES instruments(symbol),
  ref_price_paise bigint CHECK (ref_price_paise > 0),
  last_price_paise bigint CHECK (last_price_paise > 0),
  ref_source      text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────────── competitions & accounts ─────────────────────────────
CREATE TABLE competitions (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name                text NOT NULL CHECK (length(name) BETWEEN 3 AND 80),
  slug                text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{3,60}$'),
  description         text NOT NULL DEFAULT '',
  starts_at           timestamptz NOT NULL,
  ends_at             timestamptz NOT NULL,
  starting_cash_paise bigint NOT NULL CHECK (starting_cash_paise > 0),
  created_by          uuid REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);

-- One account per (user, competition). competition_id NULL = the user's main practice account.
-- Each competition gets a fresh account so everyone starts equal.
CREATE TABLE accounts (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  competition_id      bigint REFERENCES competitions(id) ON DELETE CASCADE,
  cash_paise          bigint NOT NULL CHECK (cash_paise >= 0),
  cash_held_paise     bigint NOT NULL DEFAULT 0 CHECK (cash_held_paise >= 0),
  starting_cash_paise bigint NOT NULL CHECK (starting_cash_paise > 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT held_within_cash CHECK (cash_held_paise <= cash_paise),
  CONSTRAINT one_account_per_competition UNIQUE NULLS NOT DISTINCT (user_id, competition_id)
);
CREATE INDEX accounts_competition_idx ON accounts (competition_id) WHERE competition_id IS NOT NULL;

-- Position per (account, symbol). Average-cost method: cost_basis_paise is the total cost of the units held.
CREATE TABLE holdings (
  account_id         bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  symbol             text NOT NULL REFERENCES instruments(symbol),
  qty_units          bigint NOT NULL DEFAULT 0 CHECK (qty_units >= 0),
  qty_held_units     bigint NOT NULL DEFAULT 0 CHECK (qty_held_units >= 0),
  cost_basis_paise   bigint NOT NULL DEFAULT 0 CHECK (cost_basis_paise >= 0),
  realized_pnl_paise bigint NOT NULL DEFAULT 0,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, symbol),
  CONSTRAINT held_within_qty CHECK (qty_held_units <= qty_units)
);

-- ───────────────────────────── orders ─────────────────────────────
CREATE TYPE order_side AS ENUM ('BUY', 'SELL');
CREATE TYPE order_type AS ENUM ('LIMIT', 'MARKET', 'STOP_MARKET', 'STOP_LIMIT');
CREATE TYPE order_tif AS ENUM ('GTC', 'IOC', 'FOK');
CREATE TYPE order_status AS ENUM ('PENDING', 'OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'REJECTED');

-- Current state of each order (a projection of the event log, kept for fast queries).
CREATE TABLE orders (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id          bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  symbol              text NOT NULL REFERENCES instruments(symbol),
  client_order_id     text,
  side                order_side NOT NULL,
  type                order_type NOT NULL,
  tif                 order_tif NOT NULL,
  -- qty_units = filled + still open; an amend changes it
  qty_units           bigint NOT NULL CHECK (qty_units > 0),
  filled_units        bigint NOT NULL DEFAULT 0 CHECK (filled_units >= 0),
  price_paise         bigint CHECK (price_paise > 0),
  stop_price_paise    bigint CHECK (stop_price_paise > 0),
  protect_price_paise bigint CHECK (protect_price_paise > 0),
  -- pre-trade risk reservation still held for the open part of this order
  hold_price_paise    bigint CHECK (hold_price_paise > 0),
  held_cash_paise     bigint NOT NULL DEFAULT 0 CHECK (held_cash_paise >= 0),
  held_units          bigint NOT NULL DEFAULT 0 CHECK (held_units >= 0),
  filled_notional_paise bigint NOT NULL DEFAULT 0 CHECK (filled_notional_paise >= 0),
  status              order_status NOT NULL DEFAULT 'PENDING',
  reason              text,
  -- optional exit plan the Trade Coach checks
  plan_stop_paise     bigint CHECK (plan_stop_paise > 0),
  plan_target_paise   bigint CHECK (plan_target_paise > 0),
  is_bot              boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  triggered_at        timestamptz,
  CONSTRAINT filled_within_qty CHECK (filled_units <= qty_units),
  CONSTRAINT limit_needs_price CHECK ((type IN ('LIMIT', 'STOP_LIMIT')) = (price_paise IS NOT NULL)),
  CONSTRAINT stop_needs_trigger CHECK ((type IN ('STOP_MARKET', 'STOP_LIMIT')) = (stop_price_paise IS NOT NULL)),
  CONSTRAINT market_not_gtc CHECK (type NOT IN ('MARKET', 'STOP_MARKET') OR tif <> 'GTC'),
  CONSTRAINT unique_client_order_id UNIQUE (account_id, client_order_id)
);
-- "my open orders" — a partial index only contains the (few) live orders, so it stays tiny
CREATE INDEX orders_open_idx ON orders (account_id, symbol) WHERE status IN ('PENDING', 'OPEN', 'PARTIALLY_FILLED');
CREATE INDEX orders_account_time_idx ON orders (account_id, created_at DESC);

-- ───────────────────────────── event log & trades (partitioned by day) ─────────────────────────────
-- The engine's append-only event log. Replaying it rebuilds the order book after a crash.
CREATE TABLE order_events (
  symbol     text NOT NULL,
  seq        bigint NOT NULL,
  event_type text NOT NULL,
  order_id   bigint,
  account_id bigint,
  payload    jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (symbol, seq, created_at)
) PARTITION BY RANGE (created_at);
CREATE INDEX order_events_order_idx ON order_events (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX order_events_time_brin ON order_events USING brin (created_at);

-- Exactly-once settlement: the settler applies event seq N only if last_seq = N-1, in the SAME
-- transaction that writes balances. A redelivered event is detected and skipped.
CREATE TABLE engine_offsets (
  symbol     text PRIMARY KEY REFERENCES instruments(symbol),
  last_seq   bigint NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE trades (
  id                bigint GENERATED ALWAYS AS IDENTITY,
  symbol            text NOT NULL REFERENCES instruments(symbol),
  seq               bigint NOT NULL,
  price_paise       bigint NOT NULL CHECK (price_paise > 0),
  qty_units         bigint NOT NULL CHECK (qty_units > 0),
  notional_paise    bigint NOT NULL CHECK (notional_paise > 0),
  buy_order_id      bigint NOT NULL REFERENCES orders(id),
  sell_order_id     bigint NOT NULL REFERENCES orders(id),
  buyer_account_id  bigint NOT NULL REFERENCES accounts(id),
  seller_account_id bigint NOT NULL REFERENCES accounts(id),
  aggressor         order_side NOT NULL,
  executed_at       timestamptz NOT NULL,
  PRIMARY KEY (id, executed_at),
  UNIQUE (symbol, seq, executed_at),
  CHECK (buyer_account_id <> seller_account_id)
) PARTITION BY RANGE (executed_at);
CREATE INDEX trades_symbol_time_idx ON trades (symbol, executed_at DESC);
CREATE INDEX trades_buyer_idx ON trades (buyer_account_id, executed_at DESC);
CREATE INDEX trades_seller_idx ON trades (seller_account_id, executed_at DESC);
CREATE INDEX trades_time_brin ON trades USING brin (executed_at);

-- Creates one partition per day for [from_day, from_day + days). Idempotent. Run daily by the worker.
CREATE OR REPLACE FUNCTION ensure_daily_partitions(parent regclass, from_day date, days int)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE
  d date;
  created int := 0;
  part text;
BEGIN
  FOR i IN 0 .. days - 1 LOOP
    d := from_day + i;
    part := format('%s_%s', parent::text, to_char(d, 'YYYYMMDD'));
    IF to_regclass(part) IS NULL THEN
      EXECUTE format('CREATE TABLE %I PARTITION OF %s FOR VALUES FROM (%L) TO (%L)',
                     part, parent, d::timestamptz, (d + 1)::timestamptz);
      created := created + 1;
    END IF;
  END LOOP;
  RETURN created;
END $$;

-- Partitions for the last 45 days (seeded history) and the next 7 days.
SELECT ensure_daily_partitions('order_events', current_date - 45, 53);
SELECT ensure_daily_partitions('trades', current_date - 45, 53);

-- ───────────────────────────── candles ─────────────────────────────
CREATE TABLE candles (
  symbol       text NOT NULL REFERENCES instruments(symbol),
  timeframe    text NOT NULL CHECK (timeframe IN ('1m', '5m', '1h', '1d')),
  bucket_start timestamptz NOT NULL,
  open_paise   bigint NOT NULL,
  high_paise   bigint NOT NULL,
  low_paise    bigint NOT NULL,
  close_paise  bigint NOT NULL,
  volume_units bigint NOT NULL DEFAULT 0,
  trade_count  integer NOT NULL DEFAULT 0,
  PRIMARY KEY (symbol, timeframe, bucket_start),
  CHECK (low_paise <= LEAST(open_paise, close_paise) AND high_paise >= GREATEST(open_paise, close_paise))
);

-- ───────────────────────────── bots ─────────────────────────────
CREATE TABLE bots (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id          bigint NOT NULL REFERENCES accounts(id),
  symbol              text NOT NULL REFERENCES instruments(symbol),
  spread_bps          integer NOT NULL CHECK (spread_bps BETWEEN 1 AND 1000),
  levels              integer NOT NULL DEFAULT 5 CHECK (levels BETWEEN 1 AND 20),
  level_step_bps      integer NOT NULL DEFAULT 5 CHECK (level_step_bps BETWEEN 1 AND 500),
  size_units          bigint NOT NULL CHECK (size_units > 0),
  max_inventory_units bigint NOT NULL CHECK (max_inventory_units > 0),
  enabled             boolean NOT NULL DEFAULT true,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, symbol)
);

-- ───────────────────────────── trade coach ─────────────────────────────
-- A round trip = from flat → open position → back to flat, on one symbol.
CREATE TABLE round_trips (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id           bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  symbol               text NOT NULL REFERENCES instruments(symbol),
  qty_units            bigint NOT NULL CHECK (qty_units > 0),
  entry_avg_paise      bigint NOT NULL,
  exit_avg_paise       bigint NOT NULL,
  pnl_paise            bigint NOT NULL,
  equity_at_open_paise bigint NOT NULL CHECK (equity_at_open_paise > 0),
  opened_at            timestamptz NOT NULL,
  closed_at            timestamptz NOT NULL,
  plan_stop_paise      bigint,
  plan_target_paise    bigint,
  had_stop_order       boolean NOT NULL DEFAULT false,
  entry_order_ids      bigint[] NOT NULL DEFAULT '{}',
  exit_order_ids       bigint[] NOT NULL DEFAULT '{}',
  UNIQUE (account_id, symbol, opened_at),
  CHECK (closed_at >= opened_at)
);
CREATE INDEX round_trips_account_closed_idx ON round_trips (account_id, closed_at DESC);

CREATE TABLE coach_reports (
  round_trip_id bigint PRIMARY KEY REFERENCES round_trips(id) ON DELETE CASCADE,
  grade         char(1) NOT NULL CHECK (grade IN ('A', 'B', 'C', 'D', 'F')),
  score         integer NOT NULL CHECK (score BETWEEN 0 AND 100),
  flags         text[] NOT NULL DEFAULT '{}',
  tip           text NOT NULL,
  details       jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE weekly_skill (
  account_id         bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  week_start         date NOT NULL,
  skill_score        integer NOT NULL CHECK (skill_score BETWEEN 0 AND 100),
  trades             integer NOT NULL,
  win_rate           numeric(5, 4),
  avg_win_paise      bigint,
  avg_loss_paise     bigint,
  max_drawdown_paise bigint,
  habits             text[] NOT NULL DEFAULT '{}',
  goal               text NOT NULL,
  ai_summary         text,
  computed_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, week_start)
);

CREATE TABLE badges (
  code        text PRIMARY KEY,
  name        text NOT NULL,
  description text NOT NULL,
  icon        text NOT NULL DEFAULT 'award'
);
CREATE TABLE user_badges (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  badge_code text NOT NULL REFERENCES badges(code),
  awarded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, badge_code)
);

-- Periodic equity samples → equity curve and drawdown.
CREATE TABLE equity_snapshots (
  account_id   bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  ts           timestamptz NOT NULL,
  equity_paise bigint NOT NULL,
  cash_paise   bigint NOT NULL,
  PRIMARY KEY (account_id, ts)
);
CREATE INDEX equity_snapshots_ts_brin ON equity_snapshots USING brin (ts);

CREATE TABLE app_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────────── audit log ─────────────────────────────
-- Append-only record of every balance change, written by triggers (application code can't forget it).
CREATE TABLE audit_log (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  table_name text NOT NULL,
  op         text NOT NULL,
  row_key    jsonb NOT NULL,
  old_row    jsonb,
  new_row    jsonb,
  txid       bigint NOT NULL DEFAULT txid_current(),
  db_user    text NOT NULL DEFAULT current_user,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_changed_brin ON audit_log USING brin (changed_at);

CREATE OR REPLACE FUNCTION audit_log_is_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END $$;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_is_append_only();

CREATE OR REPLACE FUNCTION audit_balance_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  k jsonb;
BEGIN
  IF TG_TABLE_NAME = 'accounts' THEN
    k := jsonb_build_object('id', COALESCE(NEW.id, OLD.id));
  ELSE
    k := jsonb_build_object('account_id', COALESCE(NEW.account_id, OLD.account_id), 'symbol', COALESCE(NEW.symbol, OLD.symbol));
  END IF;
  INSERT INTO audit_log (table_name, op, row_key, old_row, new_row)
  VALUES (TG_TABLE_NAME, TG_OP, k,
          CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END,
          CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END);
  RETURN NULL;
END $$;

-- Only real balance changes are audited (not holds), which keeps the log meaningful.
CREATE TRIGGER accounts_audit_ins AFTER INSERT OR DELETE ON accounts
  FOR EACH ROW EXECUTE FUNCTION audit_balance_change();
CREATE TRIGGER accounts_audit_upd AFTER UPDATE OF cash_paise ON accounts
  FOR EACH ROW WHEN (OLD.cash_paise IS DISTINCT FROM NEW.cash_paise) EXECUTE FUNCTION audit_balance_change();
CREATE TRIGGER holdings_audit_ins AFTER INSERT OR DELETE ON holdings
  FOR EACH ROW EXECUTE FUNCTION audit_balance_change();
CREATE TRIGGER holdings_audit_upd AFTER UPDATE OF qty_units ON holdings
  FOR EACH ROW WHEN (OLD.qty_units IS DISTINCT FROM NEW.qty_units) EXECUTE FUNCTION audit_balance_change();
