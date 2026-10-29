import { roundToTick, type InstrumentSpec } from '@tradecore/shared';
import type { MarketDataProvider, Tick } from './provider';
import { SimulatedFeed } from './simulated';

export interface RefPrice {
  symbol: string;
  pricePaise: number;
  source: string;
  ts: number;
}

export interface SymbolFeedStatus {
  source: string | null;
  pricePaise: number | null;
  ageMs: number | null;
  stale: boolean;
}

/**
 * Chooses the reference price for every symbol from several providers.
 *  - Priority order: e.g. coinbase → kraken → simulated. The first provider with a FRESH tick wins.
 *  - Failover: if a live feed goes quiet for `staleMs`, the next one takes over automatically.
 *  - The simulated feed is re-anchored to every live tick, so if all live feeds fail the price
 *    continues smoothly from the last real value instead of jumping (and the app keeps working offline).
 */
export class FeedManager {
  private last = new Map<string, Map<string, Tick>>(); // symbol → provider → last tick
  private chosen = new Map<string, string>();
  private published = new Map<string, RefPrice>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private instruments: InstrumentSpec[],
    private live: MarketDataProvider[],
    private sim: SimulatedFeed,
    private usdInr: number,
    private onRef: (r: RefPrice) => void,
    private onSwitch: (symbol: string, from: string | undefined, to: string) => void = () => {},
    private staleMs = 10_000,
    private now: () => number = Date.now,
  ) {}

  /** Provider priority for one instrument. */
  priority(spec: InstrumentSpec): string[] {
    if (spec.kind === 'SIMULATED') return ['simulated'];
    return [
      ...this.live
        .filter((p) => (spec.feed as Record<string, unknown>)[p.name] !== undefined)
        .map((p) => p.name),
      'simulated',
    ];
  }

  start(publishEveryMs = 250) {
    for (const p of this.live) {
      const products = new Map(
        this.instruments
          .filter((i) => i.kind === 'LIVE_CRYPTO' && (i.feed as Record<string, string | undefined>)[p.name])
          .map((i) => [i.symbol, (i.feed as Record<string, string>)[p.name]!]),
      );
      if (products.size) p.start(products, (t) => this.ingest(t));
    }
    this.sim.start(new Map(), (t) => this.ingest(t));
    this.timer = setInterval(() => this.publish(), publishEveryMs);
  }

  stop() {
    clearInterval(this.timer);
    for (const p of this.live) p.stop();
    this.sim.stop();
  }

  ingest(t: Tick) {
    let m = this.last.get(t.symbol);
    if (!m) this.last.set(t.symbol, (m = new Map()));
    m.set(t.source, { ...t, ts: this.now() });
    if (t.source !== 'simulated') this.sim.reanchor(t.symbol, t.price);
  }

  toPaise(t: Tick, spec: InstrumentSpec): number {
    const rupees = t.currency === 'USD' ? t.price * this.usdInr : t.price;
    return Math.max(spec.tickSizePaise, roundToTick(rupees * 100, spec.tickSizePaise));
  }

  /** Pick the best fresh source per symbol and emit a reference price if it changed. */
  publish() {
    const now = this.now();
    for (const spec of this.instruments) {
      const ticks = this.last.get(spec.symbol);
      if (!ticks) continue;
      const pick = this.priority(spec).find((name) => {
        const t = ticks.get(name);
        return t && (name === 'simulated' || now - t.ts < this.staleMs);
      });
      if (!pick) continue;
      const prev = this.chosen.get(spec.symbol);
      if (prev !== pick) {
        this.chosen.set(spec.symbol, pick);
        this.onSwitch(spec.symbol, prev, pick);
      }
      const t = ticks.get(pick)!;
      const pricePaise = this.toPaise(t, spec);
      const last = this.published.get(spec.symbol);
      if (last && last.pricePaise === pricePaise && last.source === pick && now - last.ts < 2000) continue;
      const ref = { symbol: spec.symbol, pricePaise, source: pick, ts: now };
      this.published.set(spec.symbol, ref);
      this.onRef(ref);
    }
  }

  status(): Record<string, SymbolFeedStatus> {
    const now = this.now();
    const out: Record<string, SymbolFeedStatus> = {};
    for (const spec of this.instruments) {
      const r = this.published.get(spec.symbol);
      const src = this.chosen.get(spec.symbol) ?? null;
      const t = src ? this.last.get(spec.symbol)?.get(src) : undefined;
      out[spec.symbol] = {
        source: src,
        pricePaise: r?.pricePaise ?? null,
        ageMs: t ? now - t.ts : null,
        stale: !t || (src !== 'simulated' && now - t.ts >= this.staleMs),
      };
    }
    return out;
  }

  providerStates() {
    return Object.fromEntries([...this.live, this.sim].map((p) => [p.name, p.state()]));
  }
}
