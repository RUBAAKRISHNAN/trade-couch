import type { Pool } from '@tradecore/shared/node';
import { AppError } from '../errors';

/**
 * Resolve which of the user's accounts a request acts on: the main practice account by default,
 * or their account in a competition (`competitionId`). Joining a competition creates it.
 */
export async function resolveAccount(
  pool: Pool,
  userId: string,
  competitionId?: number | null,
): Promise<number> {
  const r = await pool.query<{ id: number }>(
    'SELECT id FROM accounts WHERE user_id = $1 AND competition_id IS NOT DISTINCT FROM $2',
    [userId, competitionId ?? null],
  );
  if (!r.rows[0])
    throw new AppError(
      404,
      'NO_ACCOUNT',
      competitionId ? 'Join this competition first' : 'Account not found',
    );
  return r.rows[0].id;
}

export async function userAccountIds(pool: Pool, userId: string): Promise<number[]> {
  return (await pool.query<{ id: number }>('SELECT id FROM accounts WHERE user_id = $1', [userId])).rows.map(
    (r) => r.id,
  );
}
