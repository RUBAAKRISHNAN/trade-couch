/**
 * Matching engine process. Owns the in-memory order books (one per symbol, each strictly serial).
 * Input:  Redis stream  tc:cmd:<SYMBOL>  (from the API)   + pub/sub tc:ref:<SYMBOL> (reference prices)
 * Output: Redis stream  tc:evt:<SYMBOL>  (to the settler) + pub/sub tc:book:<SYMBOL> (book snapshots)
 */
import { channels } from '@tradecore/shared';
import { config, createPool } from '@tradecore/shared/node';
import { log, makeRedis, SymbolRunner } from './service';

const pool = createPool(undefined, 4);
const redis = makeRedis(config.redisUrl, 'engine');
const sub = makeRedis(config.redisUrl, 'engine-sub');

const only = process.env.ENGINE_SYMBOLS?.split(',').map((s) => s.trim());
const rows = (
  await pool.query<{
    symbol: string;
    tick_size_paise: number;
    lot_size_units: number;
    price_band_bps: number;
    status: string;
  }>(
    `SELECT symbol, tick_size_paise, lot_size_units, price_band_bps, status FROM instruments WHERE status <> 'DISABLED' ORDER BY symbol`,
  )
).rows.filter((r) => !only || only.includes(r.symbol));

if (rows.length === 0) {
  log.error('no instruments in the database — run `npm run db:seed` first');
  process.exit(1);
}

const runners = new Map<string, SymbolRunner>();
for (const r of rows) {
  // each runner gets its own blocking-read connection so one symbol never waits on another
  const runner = new SymbolRunner(
    {
      symbol: r.symbol,
      tickSizePaise: r.tick_size_paise,
      lotSizeUnits: r.lot_size_units,
      priceBandBps: r.price_band_bps,
    },
    redis,
    makeRedis(config.redisUrl, `engine-read-${r.symbol}`),
    pool,
  );
  await runner.recover();
  runners.set(r.symbol, runner);
  void runner.run();
}

await sub.subscribe(...rows.map((r) => channels.ref(r.symbol)));
sub.on('message', (channel, msg) => {
  const symbol = channel.slice(channels.ref('').length);
  const runner = runners.get(symbol);
  if (!runner) return;
  const { price } = JSON.parse(msg) as { price: number };
  void runner.mark(price);
});

// heartbeat for the admin health view
setInterval(() => {
  const status = Object.fromEntries(
    [...runners].map(([s, r]) => [
      s,
      JSON.stringify({
        seq: r.book.seq,
        resting: r.book.restingCount,
        processed: r.processed,
        lagMs: r.lastCommandLagMs,
        halted: r.book.halted,
        at: Date.now(),
      }),
    ]),
  );
  void redis.hset('tc:health:engine', status);
}, 1000);

log.info({ symbols: rows.map((r) => r.symbol) }, 'matching engine running');

const shutdown = async () => {
  log.info('shutting down');
  for (const r of runners.values()) r.stop();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
