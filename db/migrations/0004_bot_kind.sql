-- Two kinds of bot: MAKER quotes both sides (liquidity); FLOW takes liquidity with small market orders (activity).
ALTER TABLE bots ADD COLUMN kind text NOT NULL DEFAULT 'MAKER' CHECK (kind IN ('MAKER', 'FLOW'));
