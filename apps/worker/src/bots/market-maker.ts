import type { Side } from '@tradecore/shared';
import type { Pool } from '@tradecore/shared/node';
import { placeOrder, requestCancel, type CommandBus } from '@tradecore/api';
import type { Logger } from 'pino';

export interface MakerConfig {
  accountId: number;
  symbol: string;
  spreadBps: number;
  levels: number;
  levelStepBps: number;
  sizeUnits: number;
  maxInventoryUnits: number;
  /** inventory the bot tries to stay near */
  targetInventoryUnits: number;
  tickSizePaise: number;
  lotSizeUnits: number;
}

export interface Quote {
  side: Side;
  price: number;
  qty: number;
}

const floorTo = (x: number, step: number) => Math.floor(x / step) * step;
const ceilTo = (x: number, step: number) => Math.ceil(x / step) * step;

/**
 * MARKET MAKING: post a ladder of bids below and asks above the reference price.
 *  - The gap between best bid and best ask is the SPREAD; that's how a market maker earns.
 *  - INVENTORY SKEW: holding too much? shift both sides down (sell more eagerly, buy less eagerly).
 *    Holding too little? shift up. Past the inventory limit, stop quoting that side entirely.
 * Pure function so it can be unit-tested.
 */
export function computeQuotes(
  cfg: MakerConfig,
  refPaise: number,
  inventory: number,
  availableUnits: number,
): Quote[] {
  const excess = inventory - cfg.targetInventoryUnits;
  const skew = Math.max(-1, Math.min(1, excess / cfg.maxInventoryUnits)); // -1 … +1
  const mid = refPaise * (1 - (skew * cfg.spreadBps) / 2 / 10_000);
  const half = cfg.spreadBps / 2;
  const quotes: Quote[] = [];
  const lot = (q: number) => Math.max(cfg.lotSizeUnits, floorTo(q, cfg.lotSizeUnits));
  let unitsLeft = availableUnits;
  for (let i = 0; i < cfg.levels; i++) {
    const off = (half + i * cfg.levelStepBps) / 10_000;
    const size = lot(cfg.sizeUnits * (1 + i * 0.6));
    if (excess < cfg.maxInventoryUnits) {
      const bidSize = lot(size * (1 - Math.max(0, skew) * 0.7));
      quotes.push({ side: 'BUY', price: floorTo(mid * (1 - off), cfg.tickSizePaise), qty: bidSize });
    }
    if (excess > -cfg.maxInventoryUnits && unitsLeft >= cfg.lotSizeUnits) {
      const askSize = Math.min(unitsLeft, lot(size * (1 + Math.min(0, skew) * 0.7)));
      if (askSize >= cfg.lotSizeUnits) {
        quotes.push({
          side: 'SELL',
          price: ceilTo(mid * (1 + off), cfg.tickSizePaise),
          qty: floorTo(askSize, cfg.lotSizeUnits),
        });
        unitsLeft -= askSize;
      }
    }
  }
  return quotes.filter((q) => q.price > 0 && q.qty > 0);
}

/** Runs one market-maker bot: re-quotes when the reference price has moved enough. */
export class MarketMaker {
  private lastQuotedRef = 0;
  private lastQuotedAt = 0;
  private busy = false;

  constructor(
    private cfg: MakerConfig,
    private pool: Pool,
    private bus: CommandBus,
    private log: Logger,
    /** re-quote when the reference moves this many bps (or every maxQuoteAgeMs) */
    private requoteBps = 6,
    private maxQuoteAgeMs = 20_000,
  ) {}

  async onRef(refPaise: number): Promise<void> {
    const movedBps = this.lastQuotedRef
      ? (Math.abs(refPaise - this.lastQuotedRef) / this.lastQuotedRef) * 10_000
      : Infinity;
    const age = Date.now() - this.lastQuotedAt;
    if (this.busy || age < 750 || (movedBps < this.requoteBps && age < this.maxQuoteAgeMs)) return;
    this.busy = true;
    try {
      await this.requote(refPaise);
      this.lastQuotedRef = refPaise;
      this.lastQuotedAt = Date.now();
    } catch (e) {
      this.log.warn({ err: (e as Error).message, symbol: this.cfg.symbol }, 'market maker requote failed');
    } finally {
      this.busy = false;
    }
  }

  private async requote(refPaise: number) {
    const { accountId, symbol } = this.cfg;
    const open = await this.pool.query<{ id: number }>(
      `SELECT id FROM orders WHERE account_id = $1 AND symbol = $2 AND status IN ('PENDING','OPEN','PARTIALLY_FILLED')`,
      [accountId, symbol],
    );
    // cancels go first; the engine processes the stream in order, so old quotes are gone before new ones arrive
    for (const o of open.rows) await requestCancel(this.pool, this.bus, [accountId], o.id).catch(() => {});
    const h = await this.pool.query<{ qty_units: number; qty_held_units: number }>(
      'SELECT qty_units, qty_held_units FROM holdings WHERE account_id = $1 AND symbol = $2',
      [accountId, symbol],
    );
    const inventory = h.rows[0]?.qty_units ?? 0;
    // units still reserved by the quotes we just cancelled will free up shortly; quote from what's free now
    const free = inventory - (h.rows[0]?.qty_held_units ?? 0);
    const quotes = computeQuotes(this.cfg, refPaise, inventory, free);
    for (const q of quotes)
      await placeOrder(
        this.pool,
        this.bus,
        accountId,
        { symbol, side: q.side, type: 'LIMIT', tif: 'GTC', qty: q.qty, price: q.price },
        { isBot: true },
      ).catch((e) => this.log.debug({ err: (e as Error).message }, 'quote rejected'));
  }
}

/**
 * A "flow" bot that occasionally takes liquidity with small market orders, so the tape and candles stay
 * alive even when no human is trading. It leans against its inventory to stay roughly flat.
 */
export class FlowTrader {
  private timer: NodeJS.Timeout | undefined;
  constructor(
    private accountId: number,
    private symbol: string,
    private maxUnits: number,
    private targetInventory: number,
    private pool: Pool,
    private bus: CommandBus,
    private log: Logger,
    private minGapMs = 1500,
    private maxGapMs = 6000,
  ) {}

  start() {
    const loop = () => {
      this.timer = setTimeout(
        async () => {
          await this.tradeOnce().catch((e) =>
            this.log.debug({ err: (e as Error).message }, 'flow trade skipped'),
          );
          loop();
        },
        this.minGapMs + Math.random() * (this.maxGapMs - this.minGapMs),
      );
    };
    loop();
  }

  stop() {
    clearTimeout(this.timer);
  }

  async tradeOnce() {
    const h = await this.pool.query<{ qty_units: number }>(
      'SELECT qty_units FROM holdings WHERE account_id = $1 AND symbol = $2',
      [this.accountId, this.symbol],
    );
    const inv = h.rows[0]?.qty_units ?? 0;
    const pBuy = Math.max(
      0.1,
      Math.min(0.9, 0.5 - (inv - this.targetInventory) / (4 * this.targetInventory)),
    );
    const side: Side = Math.random() < pBuy ? 'BUY' : 'SELL';
    const qty = 1 + Math.floor(Math.random() * this.maxUnits);
    await placeOrder(
      this.pool,
      this.bus,
      this.accountId,
      { symbol: this.symbol, side, type: 'MARKET', tif: 'IOC', qty },
      { isBot: true },
    );
  }
}
