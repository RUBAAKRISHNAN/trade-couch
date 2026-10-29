-- An amend that needs MORE hold (e.g. raising a buy price) reserves the extra up front.
-- The reservation is tracked separately until the engine confirms (AMENDED) or rejects the amend,
-- so unrelated events in between (fills) can't accidentally release it.
ALTER TABLE orders
  ADD COLUMN amend_reserve_paise bigint NOT NULL DEFAULT 0 CHECK (amend_reserve_paise >= 0),
  ADD COLUMN amend_reserve_units bigint NOT NULL DEFAULT 0 CHECK (amend_reserve_units >= 0),
  ADD COLUMN amend_pending boolean NOT NULL DEFAULT false;
