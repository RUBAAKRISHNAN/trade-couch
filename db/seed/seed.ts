/**
 * Idempotent, non-destructive seed: only inserts what is missing, never deletes or truncates.
 *   npm run db:seed
 * Demo password for every seeded human user: Demo@1234 (also noted in .env.example).
 */
import bcrypt from 'bcryptjs';
import { INSTRUMENTS, STARTING_CASH_PAISE } from '@tradecore/shared';
import { createPool, withTx, type PoolClient } from '@tradecore/shared/node';
import { createAccount, grantUnits } from '../../apps/api/src/trading/accounts';
import { seedDemo } from './demo';

const DEMO_PASSWORD = 'Demo@1234';
// All instruments by default; SEED_SYMBOLS=BTC-INR,ETH-INR limits it. SEED_DEMO=0 skips the demo history.
const ENABLED = new Set(
  (process.env.SEED_SYMBOLS ?? INSTRUMENTS.map((i) => i.symbol).join(',')).split(',').map((s) => s.trim()),
);

/** Per-instrument bot settings. Sizes are in units (see qtyScale). */
const BOT_CFG: Record<
  string,
  { mm: [number, number, number, number, number]; inventory: number; flowSize: number; flowInventory: number }
> = {
  //            spread, levels, step, size, maxInv
  'BTC-INR': { mm: [8, 8, 3, 20, 3000], inventory: 5000, flowSize: 5, flowInventory: 500 },
  'ETH-INR': { mm: [10, 8, 4, 50, 8000], inventory: 15_000, flowSize: 20, flowInventory: 2000 },
  'SOL-INR': { mm: [12, 8, 5, 100, 20_000], inventory: 40_000, flowSize: 50, flowInventory: 4000 },
  'SIM-NIFTY': { mm: [6, 8, 3, 2, 300], inventory: 500, flowSize: 2, flowInventory: 60 },
  'SIM-RELIANCE': { mm: [8, 8, 4, 10, 2000], inventory: 4000, flowSize: 8, flowInventory: 400 },
  'SIM-TCS': { mm: [8, 8, 4, 5, 1000], inventory: 2000, flowSize: 4, flowInventory: 200 },
};

const pool = createPool();

async function upsertUser(
  c: PoolClient,
  email: string,
  name: string,
  role: 'USER' | 'ADMIN' | 'BOT',
  hash: string,
) {
  const r = await c.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, display_name, role) VALUES ($1, $2, $3, $4)
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id`,
    [email, hash, name, role],
  );
  return r.rows[0]!.id;
}

async function mainAccount(
  c: PoolClient,
  userId: string,
  cash: number,
): Promise<{ id: number; created: boolean }> {
  const r = await c.query<{ id: number }>(
    'SELECT id FROM accounts WHERE user_id = $1 AND competition_id IS NULL',
    [userId],
  );
  if (r.rows[0]) return { id: r.rows[0].id, created: false };
  return { id: await createAccount(c, userId, null, cash), created: true };
}

const hash = await bcrypt.hash(DEMO_PASSWORD, 10);

await withTx(pool, async (c) => {
  // instruments
  for (const i of INSTRUMENTS) {
    await c.query(
      `INSERT INTO instruments (symbol, name, kind, tick_size_paise, lot_size_units, qty_scale, price_band_bps, feed, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (symbol) DO NOTHING`,
      [
        i.symbol,
        i.name,
        i.kind,
        i.tickSizePaise,
        i.lotSizeUnits,
        i.qtyScale,
        i.priceBandBps,
        JSON.stringify(i.feed),
        ENABLED.has(i.symbol) ? 'ACTIVE' : 'DISABLED',
      ],
    );
    if (ENABLED.has(i.symbol))
      await c.query(`UPDATE instruments SET status = 'ACTIVE' WHERE symbol = $1 AND status = 'DISABLED'`, [
        i.symbol,
      ]);
    await c.query('INSERT INTO engine_offsets (symbol) VALUES ($1) ON CONFLICT DO NOTHING', [i.symbol]);
  }

  // humans
  const humans: [string, string, 'USER' | 'ADMIN'][] = [
    ['admin@tradecore.dev', 'Admin', 'ADMIN'],
    ['asha@tradecore.dev', 'Asha', 'USER'],
    ['rahul@tradecore.dev', 'Rahul', 'USER'],
    ['meera@tradecore.dev', 'Meera', 'USER'],
  ];
  for (const [email, name, role] of humans) {
    const id = await upsertUser(c, email, name, role, hash);
    await mainAccount(c, id, STARTING_CASH_PAISE);
  }

  // bots: one market maker + one flow trader per enabled instrument, each with its own account
  const botHash = await bcrypt.hash(`bot-${Math.random()}`, 4); // bots never log in
  for (const i of INSTRUMENTS.filter((x) => ENABLED.has(x.symbol))) {
    const cfg = BOT_CFG[i.symbol]!;
    const slug = i.symbol.toLowerCase();
    const mmUser = await upsertUser(c, `mm-${slug}@bots.tradecore.dev`, `MM ${i.symbol}`, 'BOT', botHash);
    const mm = await mainAccount(c, mmUser, 2_00_00_000_00); // ₹2 crore
    if (mm.created)
      await grantUnits(
        c,
        mm.id,
        i.symbol,
        cfg.inventory,
        ((i.feed.simStartPaise ?? 0) * cfg.inventory) / i.qtyScale,
        'market maker inventory',
      );
    const [spread, levels, step, size, maxInv] = cfg.mm;
    await c.query(
      `INSERT INTO bots (account_id, symbol, kind, spread_bps, levels, level_step_bps, size_units, max_inventory_units)
       VALUES ($1,$2,'MAKER',$3,$4,$5,$6,$7) ON CONFLICT (account_id, symbol) DO NOTHING`,
      [mm.id, i.symbol, spread, levels, step, size, maxInv],
    );
    const flowUser = await upsertUser(
      c,
      `flow-${slug}@bots.tradecore.dev`,
      `Flow ${i.symbol}`,
      'BOT',
      botHash,
    );
    const flow = await mainAccount(c, flowUser, 50_00_000_00); // ₹50 lakh
    if (flow.created)
      await grantUnits(
        c,
        flow.id,
        i.symbol,
        cfg.flowInventory,
        ((i.feed.simStartPaise ?? 0) * cfg.flowInventory) / i.qtyScale,
        'flow trader inventory',
      );
    await c.query(
      `INSERT INTO bots (account_id, symbol, kind, spread_bps, levels, level_step_bps, size_units, max_inventory_units)
       VALUES ($1,$2,'FLOW',1,1,1,$3,$4) ON CONFLICT (account_id, symbol) DO NOTHING`,
      [flow.id, i.symbol, cfg.flowSize, cfg.flowInventory],
    );
  }
});

if (process.env.SEED_DEMO !== '0') console.log('demo data:', await seedDemo(pool, hash));

const counts = (
  await pool.query(`SELECT (SELECT count(*) FROM users)::int AS users, (SELECT count(*) FROM accounts)::int AS accounts,
    (SELECT count(*) FROM bots)::int AS bots, (SELECT string_agg(symbol, ',') FROM instruments WHERE status = 'ACTIVE') AS active`)
).rows[0];
console.log('seed complete:', counts);
await pool.end();
