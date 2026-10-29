import type { Pool } from '@tradecore/shared/node';

/**
 * Ledger invariants, checked with SQL against the live database. Each check returns offending rows;
 * an empty result means the invariant holds. Used by `npm run check:invariants` and the integration tests.
 */
// TODO(me) [Phase 3 task, ~20 min]: add an invariant "no-stuck-pending-orders": orders still PENDING more than
//   60 seconds after created_at (the engine never answered). Then make the tamper test in
//   apps/api/test/settlement.test.ts prove it fires (UPDATE an order back to PENDING with an old created_at).
export const INVARIANTS: { name: string; explain: string; sql: string }[] = [
  {
    name: 'no-negative-balances',
    explain: 'No account has negative cash or holds more than it owns; no holding is negative.',
    sql: `SELECT 'account' AS kind, id::text AS key FROM accounts
            WHERE cash_paise < 0 OR cash_held_paise < 0 OR cash_held_paise > cash_paise
          UNION ALL
          SELECT 'holding', account_id || '/' || symbol FROM holdings
            WHERE qty_units < 0 OR qty_held_units < 0 OR qty_held_units > qty_units`,
  },
  {
    name: 'cash-conserved-per-account',
    explain: 'For every account: cash = cash grants − what it paid for buys + what it received for sells.',
    sql: `WITH g AS (SELECT account_id, SUM(cash_paise) AS granted FROM asset_grants GROUP BY account_id),
               t AS (SELECT account_id, SUM(delta) AS traded FROM (
                       SELECT buyer_account_id AS account_id, -notional_paise AS delta FROM trades
                       UNION ALL SELECT seller_account_id, notional_paise FROM trades) x GROUP BY account_id)
          SELECT a.id, a.cash_paise, COALESCE(g.granted, 0) + COALESCE(t.traded, 0) AS expected
          FROM accounts a LEFT JOIN g ON g.account_id = a.id LEFT JOIN t ON t.account_id = a.id
          WHERE a.cash_paise <> COALESCE(g.granted, 0) + COALESCE(t.traded, 0)`,
  },
  {
    name: 'units-conserved-per-holding',
    explain: 'For every holding: units = unit grants + bought − sold.',
    sql: `WITH g AS (SELECT account_id, symbol, SUM(qty_units) AS granted FROM asset_grants WHERE symbol IS NOT NULL GROUP BY 1, 2),
               t AS (SELECT account_id, symbol, SUM(delta) AS traded FROM (
                       SELECT buyer_account_id AS account_id, symbol, qty_units AS delta FROM trades
                       UNION ALL SELECT seller_account_id, symbol, -qty_units FROM trades) x GROUP BY 1, 2)
          SELECT h.account_id, h.symbol, h.qty_units, COALESCE(g.granted, 0) + COALESCE(t.traded, 0) AS expected
          FROM holdings h
          LEFT JOIN g ON g.account_id = h.account_id AND g.symbol = h.symbol
          LEFT JOIN t ON t.account_id = h.account_id AND t.symbol = h.symbol
          WHERE h.qty_units <> COALESCE(g.granted, 0) + COALESCE(t.traded, 0)`,
  },
  {
    name: 'total-cash-conserved',
    explain: 'All the virtual cash in the system equals all the cash ever granted (trades only move it).',
    sql: `SELECT (SELECT COALESCE(SUM(cash_paise), 0) FROM accounts) AS total,
                 (SELECT COALESCE(SUM(cash_paise), 0) FROM asset_grants) AS granted
          WHERE (SELECT COALESCE(SUM(cash_paise), 0) FROM accounts) <> (SELECT COALESCE(SUM(cash_paise), 0) FROM asset_grants)`,
  },
  {
    name: 'holds-match-open-orders',
    explain: "An account's held cash/units equal the sum of what its open orders reserve.",
    sql: `SELECT a.id, a.cash_held_paise, COALESCE(SUM(o.held_cash_paise), 0) AS orders_hold
          FROM accounts a LEFT JOIN orders o ON o.account_id = a.id
          GROUP BY a.id HAVING a.cash_held_paise <> COALESCE(SUM(o.held_cash_paise), 0)
          UNION ALL
          SELECT h.account_id, h.qty_held_units, COALESCE(SUM(o.held_units), 0)
          FROM holdings h LEFT JOIN orders o ON o.account_id = h.account_id AND o.symbol = h.symbol
          GROUP BY h.account_id, h.symbol, h.qty_held_units HAVING h.qty_held_units <> COALESCE(SUM(o.held_units), 0)`,
  },
  {
    name: 'closed-orders-hold-nothing',
    explain: 'Filled, cancelled and rejected orders have released their whole reservation.',
    sql: `SELECT id, status, held_cash_paise, held_units FROM orders
          WHERE status IN ('FILLED', 'CANCELLED', 'REJECTED') AND (held_cash_paise <> 0 OR held_units <> 0)`,
  },
  {
    name: 'fills-settled-exactly-once',
    explain: 'Every TRADE event has exactly one trades row, and each order’s filled qty equals its trades.',
    sql: `SELECT 'missing-or-duplicate' AS problem, e.symbol, e.seq, COUNT(t.id) AS rows
          FROM order_events e LEFT JOIN trades t ON t.symbol = e.symbol AND t.seq = e.seq
          WHERE e.event_type = 'TRADE' GROUP BY e.symbol, e.seq HAVING COUNT(t.id) <> 1
          UNION ALL
          SELECT 'orphan-trade', t.symbol, t.seq, 0 FROM trades t
          WHERE NOT EXISTS (SELECT 1 FROM order_events e WHERE e.symbol = t.symbol AND e.seq = t.seq AND e.event_type = 'TRADE')
          UNION ALL
          SELECT 'filled-mismatch', o.symbol, o.id, o.filled_units FROM orders o
          WHERE o.filled_units <> (SELECT COALESCE(SUM(qty_units), 0) FROM trades t WHERE t.buy_order_id = o.id OR t.sell_order_id = o.id)`,
  },
  {
    name: 'event-log-gap-free',
    explain: 'Per symbol, the event log has seq 1..last_seq with no gaps, matching the settlement offset.',
    sql: `SELECT o.symbol, o.last_seq, COUNT(e.seq) AS events, MAX(e.seq) AS max_seq
          FROM engine_offsets o LEFT JOIN order_events e ON e.symbol = o.symbol
          GROUP BY o.symbol, o.last_seq
          HAVING COUNT(e.seq) <> o.last_seq OR COALESCE(MAX(e.seq), 0) <> o.last_seq`,
  },
];

export interface InvariantReport {
  ok: boolean;
  results: { name: string; explain: string; ok: boolean; violations: unknown[] }[];
}

export async function checkInvariants(pool: Pool): Promise<InvariantReport> {
  const results = [];
  for (const inv of INVARIANTS) {
    const r = await pool.query(`${inv.sql} LIMIT 20`);
    results.push({ name: inv.name, explain: inv.explain, ok: r.rowCount === 0, violations: r.rows });
  }
  return { ok: results.every((r) => r.ok), results };
}
