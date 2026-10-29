-- Every balance that did NOT come from a trade (starting cash, bot inventory, admin top-ups) is recorded here.
-- That makes conservation checkable: cash/units of any account = grants + what its trades moved.
CREATE TABLE asset_grants (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id  bigint NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  symbol      text REFERENCES instruments(symbol),          -- NULL = cash grant
  cash_paise  bigint NOT NULL DEFAULT 0 CHECK (cash_paise >= 0),
  qty_units   bigint NOT NULL DEFAULT 0 CHECK (qty_units >= 0),
  reason      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((symbol IS NULL AND qty_units = 0) OR (symbol IS NOT NULL AND cash_paise = 0))
);
CREATE INDEX asset_grants_account_idx ON asset_grants (account_id);
