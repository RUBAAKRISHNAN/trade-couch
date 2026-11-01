import { INSTRUMENTS, getInstrument, type EngineCommand, type EngineEvent } from '@tradecore/shared';
import { createPool, withTx, type Pool } from '@tradecore/shared/node';
import { OrderBook } from '@tradecore/engine';
import type { CommandBus } from '../src/trading/orders';
import { settleBatch } from '../src/trading/settlement';
import { createAccount, grantUnits } from '../src/trading/accounts';

let pool: Pool | undefined;
export function testPool(): Pool {
  pool ??= createPool('tradecore_test', 20);
  return pool;
}

/** Wipes all data in the TEST database (refuses to run anywhere else). */
export async function resetDb(p = testPool()) {
  const db = (await p.query<{ d: string }>('SELECT current_database() AS d')).rows[0]!.d;
  if (db !== 'tradecore_test') throw new Error(`refusing to reset database ${db}`);
  // DELETE (not TRUNCATE): TRUNCATE has to visit every daily partition and takes seconds; the test tables are tiny.
  await withTx(p, async (c) => {
    await c.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update');
    for (const t of [
      'coach_positions',
      'coach_cursors',
      'trades',
      'order_events',
      'coach_reports',
      'round_trips',
      'weekly_skill',
      'equity_snapshots',
      'user_badges',
      'badges',
      'asset_grants',
      'orders',
      'holdings',
      'bots',
      'accounts',
      'competitions',
      'refresh_tokens',
      'users',
      'candles',
      'market_prices',
      'engine_offsets',
      'instruments',
      'app_settings',
      'audit_log',
    ])
      await c.query(`DELETE FROM ${t}`);
    await c.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update');
  });
}

export async function seedInstrument(symbol = 'BTC-INR', refPrice?: number, p = testPool()) {
  const i = INSTRUMENTS.find((x) => x.symbol === symbol)!;
  await p.query(
    `INSERT INTO instruments (symbol, name, kind, tick_size_paise, lot_size_units, qty_scale, price_band_bps, feed)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
    [
      i.symbol,
      i.name,
      i.kind,
      i.tickSizePaise,
      i.lotSizeUnits,
      i.qtyScale,
      i.priceBandBps,
      JSON.stringify(i.feed),
    ],
  );
  if (refPrice)
    await p.query(
      `INSERT INTO market_prices (symbol, ref_price_paise) VALUES ($1, $2)
       ON CONFLICT (symbol) DO UPDATE SET ref_price_paise = EXCLUDED.ref_price_paise`,
      [symbol, refPrice],
    );
}

let userN = 0;
export async function makeUser(opts: { cash?: number; units?: Record<string, number> } = {}, p = testPool()) {
  return withTx(p, async (c) => {
    const n = ++userN;
    const u = await c.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', $2) RETURNING id`,
      [`user${n}-${Date.now()}@test.dev`, `User ${n}`],
    );
    const accountId = await createAccount(c, u.rows[0]!.id, null, opts.cash);
    for (const [sym, qty] of Object.entries(opts.units ?? {})) {
      const spec = getInstrument(sym);
      await grantUnits(
        c,
        accountId,
        sym,
        qty,
        Math.round(((spec.feed.simStartPaise ?? 0) * qty) / spec.qtyScale),
        'test',
      );
    }
    return { userId: u.rows[0]!.id, accountId };
  });
}

/**
 * Engine + settler wired together in-process (no Redis). Settlement per symbol is serialised with a
 * promise chain, exactly like the real settler which consumes the event stream in order.
 */
export class InProcessExchange implements CommandBus {
  books = new Map<string, OrderBook>();
  log = new Map<string, EngineEvent[]>();
  private chains = new Map<string, Promise<unknown>>();
  constructor(
    private pool: Pool,
    public autoSettle = true,
  ) {}

  book(symbol: string) {
    let b = this.books.get(symbol);
    if (!b) {
      const s = getInstrument(symbol);
      b = new OrderBook({
        symbol,
        tickSizePaise: s.tickSizePaise,
        lotSizeUnits: s.lotSizeUnits,
        priceBandBps: s.priceBandBps,
      });
      this.books.set(symbol, b);
      this.log.set(symbol, []);
    }
    return b;
  }

  async send(symbol: string, cmd: EngineCommand) {
    const evs = this.book(symbol).process(cmd);
    this.log.get(symbol)!.push(...evs);
    if (this.autoSettle && evs.length) await this.settle(symbol, evs);
  }

  settle(symbol: string, evs: EngineEvent[]) {
    const prev = this.chains.get(symbol) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => settleBatch(this.pool, symbol, evs));
    this.chains.set(symbol, next);
    return next;
  }
}

export async function balances(accountId: number, symbol = 'BTC-INR', p = testPool()) {
  const a = (await p.query('SELECT cash_paise, cash_held_paise FROM accounts WHERE id = $1', [accountId]))
    .rows[0];
  const h = (
    await p.query(
      'SELECT qty_units, qty_held_units, cost_basis_paise, realized_pnl_paise FROM holdings WHERE account_id = $1 AND symbol = $2',
      [accountId, symbol],
    )
  ).rows[0];
  return {
    ...a,
    ...(h ?? { qty_units: 0, qty_held_units: 0, cost_basis_paise: 0, realized_pnl_paise: 0 }),
  } as {
    cash_paise: number;
    cash_held_paise: number;
    qty_units: number;
    qty_held_units: number;
    cost_basis_paise: number;
    realized_pnl_paise: number;
  };
}
