/**
 * Engine-only benchmark: how fast can one OrderBook (one symbol, one thread) process commands?
 * No Redis, no Postgres — this measures the matching engine itself.
 *
 *   npm run bench:engine            (1,000,000 commands)
 *   npm run bench:engine -- 200000  (custom count)
 */
import os from 'node:os';
import type { EngineCommand } from '@tradecore/shared';
import { OrderBook } from '../src';

const N = Number(process.argv[2] ?? 1_000_000);
const WARMUP = 50_000;

/** Small deterministic PRNG (mulberry32) so every run uses the same order flow. */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generate(n: number, seed: number): EngineCommand[] {
  const r = rng(seed);
  const cmds: EngineCommand[] = [];
  const live: { id: number; acct: number }[] = [];
  let id = 1;
  const mid = 10_000;
  for (let i = 0; i < n; i++) {
    const x = r();
    const acct = 1 + Math.floor(r() * 1000);
    if (x < 0.7 || live.length === 0) {
      // limit order: 70%, priced within ±50 ticks of mid, skewed so most rest and some cross
      const side = r() < 0.5 ? 'BUY' : 'SELL';
      const off = Math.floor(r() * 50) - 5;
      const price = (side === 'BUY' ? mid - off : mid + off) * 100;
      const orderId = id++;
      cmds.push({
        kind: 'NEW',
        orderId,
        accountId: acct,
        side,
        type: 'LIMIT',
        tif: 'GTC',
        qty: 1 + Math.floor(r() * 20),
        price,
        ts: i,
      });
      live.push({ id: orderId, acct });
    } else if (x < 0.9) {
      // cancel a random earlier order: 20% (some will already be filled → UNKNOWN_ORDER reject, as in real life)
      const k = Math.floor(r() * live.length);
      const o = live[k]!;
      live[k] = live[live.length - 1]!;
      live.pop();
      cmds.push({ kind: 'CANCEL', orderId: o.id, accountId: o.acct, ts: i });
    } else {
      // market order: 10%
      const side = r() < 0.5 ? 'BUY' : 'SELL';
      cmds.push({
        kind: 'NEW',
        orderId: id++,
        accountId: acct,
        side,
        type: 'MARKET',
        tif: 'IOC',
        qty: 1 + Math.floor(r() * 30),
        protectPrice: (side === 'BUY' ? mid + 200 : mid - 200) * 100,
        ts: i,
      });
    }
  }
  return cmds;
}

function pct(sorted: Float64Array, p: number) {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

const cfg = { symbol: 'BENCH', tickSizePaise: 100, lotSizeUnits: 1, priceBandBps: 10_000 };

// warm-up so V8 optimises the hot paths before we measure
{
  const b = new OrderBook(cfg);
  for (const c of generate(WARMUP, 7)) b.process(c);
}

const cmds = generate(N, 42);
const book = new OrderBook(cfg);
const lat = new Float64Array(N);
let trades = 0;
let events = 0;
const t0 = process.hrtime.bigint();
for (let i = 0; i < N; i++) {
  const s = process.hrtime.bigint();
  const evs = book.process(cmds[i]!);
  lat[i] = Number(process.hrtime.bigint() - s);
  events += evs.length;
  for (const e of evs) if (e.type === 'TRADE') trades++;
}
const elapsedNs = Number(process.hrtime.bigint() - t0);
lat.sort();

const cpu = os.cpus()[0]?.model.trim() ?? 'unknown CPU';
const result = {
  commands: N,
  trades,
  events,
  seconds: +(elapsedNs / 1e9).toFixed(3),
  commandsPerSec: Math.round(N / (elapsedNs / 1e9)),
  latencyMicros: {
    p50: +(pct(lat, 50) / 1000).toFixed(2),
    p99: +(pct(lat, 99) / 1000).toFixed(2),
    p999: +(pct(lat, 99.9) / 1000).toFixed(2),
    max: +(lat[N - 1]! / 1000).toFixed(1),
  },
  restingOrdersAtEnd: book.restingCount,
  bidLevels: book.bids.levelCount,
  askLevels: book.asks.levelCount,
  machine: `${cpu} · ${os.cpus().length} logical cores · ${(os.totalmem() / 2 ** 30).toFixed(1)} GB RAM · ${os.platform()} ${os.release()} · Node ${process.version}`,
};
console.log(JSON.stringify(result, null, 2));
console.log(
  `\n${result.commandsPerSec.toLocaleString()} commands/sec · p50 ${result.latencyMicros.p50}µs · p99 ${result.latencyMicros.p99}µs (single thread, one symbol)`,
);
