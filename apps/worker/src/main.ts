/**
 * Worker process:
 *  - settlers: one per symbol, engine events → Postgres (exactly once)
 *  - market data: live feeds with failover + simulated fallback → reference prices
 *  - bots: market makers (liquidity) and flow traders (activity)
 *  - scheduled jobs (BullMQ): see ./jobs
 */
import { Redis } from 'ioredis';
import pino from 'pino';
import { channels, INSTRUMENTS, type InstrumentSpec } from '@tradecore/shared';
import { config, createPool } from '@tradecore/shared/node';
import { RedisCommandBus } from '@tradecore/api';
import { FlowTrader, MarketMaker } from './bots/market-maker';
import { BinanceFeed } from './market/binance';
import { CoinbaseFeed } from './market/coinbase';
import { KrakenFeed } from './market/kraken';
import { FeedManager } from './market/manager';
import type { MarketDataProvider } from './market/provider';
import { SimulatedFeed } from './market/simulated';
import { Settler } from './settler';
import { startJobs } from './jobs';

const log = pino({ name: 'worker', level: process.env.LOG_LEVEL ?? 'info' });
const redisOpts = { maxRetriesPerRequest: null };
const pool = createPool(undefined, 10);
const redis = new Redis(config.redisUrl, { ...redisOpts, connectionName: 'worker' });
const bus = new RedisCommandBus(redis);

// ── instruments (DB is the source of truth; shared config supplies feed product ids as a fallback)
const rows = (
  await pool.query<{
    symbol: string;
    name: string;
    kind: InstrumentSpec['kind'];
    tick_size_paise: number;
    lot_size_units: number;
    qty_scale: number;
    price_band_bps: number;
    feed: InstrumentSpec['feed'];
  }>(
    `SELECT symbol, name, kind, tick_size_paise, lot_size_units, qty_scale, price_band_bps, feed FROM instruments WHERE status <> 'DISABLED'`,
  )
).rows;
if (!rows.length) {
  log.error('no instruments — run `npm run db:seed` first');
  process.exit(1);
}
const specs: InstrumentSpec[] = rows.map((r) => ({
  symbol: r.symbol,
  name: r.name,
  kind: r.kind,
  tickSizePaise: r.tick_size_paise,
  lotSizeUnits: r.lot_size_units,
  qtyScale: r.qty_scale,
  priceBandBps: r.price_band_bps,
  feed: { ...INSTRUMENTS.find((i) => i.symbol === r.symbol)?.feed, ...r.feed },
  enabled: true,
}));

// ── settlers
const settlers = specs.map(
  (s) =>
    new Settler(
      s.symbol,
      redis,
      new Redis(config.redisUrl, { ...redisOpts, connectionName: `settler-${s.symbol}` }),
      pool,
      log,
    ),
);
for (const s of settlers) void s.run();

// ── bots
const makers = new Map<string, MarketMaker[]>();
const flows: FlowTrader[] = [];
const bots = (
  await pool.query<{
    account_id: number;
    symbol: string;
    kind: string;
    spread_bps: number;
    levels: number;
    level_step_bps: number;
    size_units: number;
    max_inventory_units: number;
  }>('SELECT * FROM bots WHERE enabled')
).rows;
const grants = await pool.query<{ account_id: number; symbol: string; qty: number }>(
  'SELECT account_id, symbol, SUM(qty_units)::bigint AS qty FROM asset_grants WHERE symbol IS NOT NULL GROUP BY 1, 2',
);
const target = (acct: number, sym: string) =>
  grants.rows.find((g) => g.account_id === acct && g.symbol === sym)?.qty ?? 0;
for (const b of bots) {
  const spec = specs.find((s) => s.symbol === b.symbol);
  if (!spec) continue;
  if (b.kind === 'FLOW') {
    flows.push(
      new FlowTrader(b.account_id, b.symbol, b.size_units, target(b.account_id, b.symbol), pool, bus, log),
    );
  } else {
    const m = new MarketMaker(
      {
        accountId: b.account_id,
        symbol: b.symbol,
        spreadBps: b.spread_bps,
        levels: b.levels,
        levelStepBps: b.level_step_bps,
        sizeUnits: b.size_units,
        maxInventoryUnits: b.max_inventory_units,
        targetInventoryUnits: target(b.account_id, b.symbol),
        tickSizePaise: spec.tickSizePaise,
        lotSizeUnits: spec.lotSizeUnits,
      },
      pool,
      bus,
      log,
    );
    makers.set(b.symbol, [...(makers.get(b.symbol) ?? []), m]);
  }
}
// give makers a few seconds to post quotes before flow traders start taking liquidity
setTimeout(() => flows.forEach((f) => f.start()), 5000);

// ── market data
const providers: Record<string, () => MarketDataProvider> = {
  coinbase: () => new CoinbaseFeed(),
  binance: () => new BinanceFeed(),
  kraken: () => new KrakenFeed(),
};
const live = config.marketFeeds.filter((n) => providers[n]).map((n) => providers[n]!());
const sim = new SimulatedFeed(
  new Map(
    specs.map((s) => [
      s.symbol,
      s.kind === 'LIVE_CRYPTO'
        ? {
            start: (s.feed.simStartPaise ?? 1e8) / 100 / config.usdInr,
            sigma: s.feed.simVolatility ?? 0.5,
            currency: 'USD' as const,
          }
        : {
            start: (s.feed.simStartPaise ?? 1e5) / 100,
            sigma: s.feed.simVolatility ?? 0.2,
            currency: 'INR' as const,
          },
    ]),
  ),
  Number(process.env.SIM_SEED ?? 42),
);
const lastDbWrite = new Map<string, number>();
const feeds = new FeedManager(
  specs,
  live,
  sim,
  config.usdInr,
  (ref) => {
    const msg = JSON.stringify({ price: ref.pricePaise, source: ref.source, ts: ref.ts });
    void redis.pipeline().publish(channels.ref(ref.symbol), msg).set(`tc:ref:${ref.symbol}`, msg).exec();
    for (const m of makers.get(ref.symbol) ?? []) void m.onRef(ref.pricePaise);
    if (Date.now() - (lastDbWrite.get(ref.symbol) ?? 0) > 2000) {
      lastDbWrite.set(ref.symbol, Date.now());
      void pool.query(
        `INSERT INTO market_prices (symbol, ref_price_paise, ref_source, updated_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (symbol) DO UPDATE SET ref_price_paise = EXCLUDED.ref_price_paise, ref_source = EXCLUDED.ref_source, updated_at = now()`,
        [ref.symbol, ref.pricePaise, ref.source],
      );
    }
  },
  (symbol, from, to) => log.info({ symbol, from: from ?? 'none', to }, 'reference price source switched'),
);
feeds.start();

setInterval(() => {
  void redis.hset('tc:health:feeds', {
    symbols: JSON.stringify(feeds.status()),
    providers: JSON.stringify(feeds.providerStates()),
    settlers: JSON.stringify(
      Object.fromEntries(
        settlers.map((s, i) => [specs[i]!.symbol, { settled: s.settled, lastSettledAt: s.lastSettledAt }]),
      ),
    ),
    usdInr: String(config.usdInr),
    at: String(Date.now()),
  });
}, 1000);

const jobs = await startJobs(pool, log);

log.info(
  {
    symbols: specs.map((s) => s.symbol),
    feeds: live.map((p) => p.name),
    makers: [...makers.values()].flat().length,
    flows: flows.length,
  },
  'worker running',
);

const shutdown = async () => {
  feeds.stop();
  flows.forEach((f) => f.stop());
  settlers.forEach((s) => s.stop());
  await jobs.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
