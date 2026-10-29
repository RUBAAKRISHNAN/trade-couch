import { STARTING_CASH_PAISE } from '@tradecore/shared';
import type { PoolClient } from '@tradecore/shared/node';

/** Creates an account and records its starting cash as a grant (so conservation can be verified). */
export async function createAccount(
  c: PoolClient,
  userId: string,
  competitionId: number | null = null,
  cash = STARTING_CASH_PAISE,
): Promise<number> {
  const r = await c.query<{ id: number }>(
    `INSERT INTO accounts (user_id, competition_id, cash_paise, starting_cash_paise) VALUES ($1, $2, $3, $3) RETURNING id`,
    [userId, competitionId, cash],
  );
  const id = r.rows[0]!.id;
  await c.query(
    `INSERT INTO asset_grants (account_id, cash_paise, reason) VALUES ($1, $2, 'starting cash')`,
    [id, cash],
  );
  return id;
}

/** Gives an account units of an instrument (bot inventory, seed data), recorded as a grant. */
export async function grantUnits(
  c: PoolClient,
  accountId: number,
  symbol: string,
  qty: number,
  costBasisPaise: number,
  reason: string,
) {
  await c.query(
    `INSERT INTO holdings (account_id, symbol, qty_units, cost_basis_paise) VALUES ($1, $2, $3, $4)
     ON CONFLICT (account_id, symbol) DO UPDATE SET qty_units = holdings.qty_units + EXCLUDED.qty_units,
       cost_basis_paise = holdings.cost_basis_paise + EXCLUDED.cost_basis_paise`,
    [accountId, symbol, qty, costBasisPaise],
  );
  await c.query(`INSERT INTO asset_grants (account_id, symbol, qty_units, reason) VALUES ($1, $2, $3, $4)`, [
    accountId,
    symbol,
    qty,
    reason,
  ]);
}
