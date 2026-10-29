export type InstrumentKind = 'LIVE_CRYPTO' | 'SIMULATED';

export interface InstrumentSpec {
  symbol: string;
  name: string;
  kind: InstrumentKind;
  /** Smallest price step, in paise. Must be a multiple of qtyScale so notionals are integral. */
  tickSizePaise: number;
  /** Orders must be a multiple of this many units. */
  lotSizeUnits: number;
  /** How many units make one whole coin/share. */
  qtyScale: number;
  /** Reject limit orders further than this from the reference price (basis points; 500 = 5%). */
  priceBandBps: number;
  /** For live feeds: product ids per provider. For simulated: GBM seed parameters. */
  feed: { coinbase?: string; kraken?: string; simStartPaise?: number; simVolatility?: number };
  enabled: boolean;
}

export const INSTRUMENTS: InstrumentSpec[] = [
  {
    symbol: 'BTC-INR',
    name: 'Bitcoin',
    kind: 'LIVE_CRYPTO',
    tickSizePaise: 10_000, // ₹100
    lotSizeUnits: 1,
    qtyScale: 10_000, // 1 unit = 0.0001 BTC
    priceBandBps: 500,
    feed: { coinbase: 'BTC-USD', kraken: 'XBT/USD', simStartPaise: 95_00_000_00, simVolatility: 0.6 },
    enabled: true,
  },
  {
    symbol: 'ETH-INR',
    name: 'Ethereum',
    kind: 'LIVE_CRYPTO',
    tickSizePaise: 1_000, // ₹10
    lotSizeUnits: 1,
    qtyScale: 1_000, // 0.001 ETH
    priceBandBps: 500,
    feed: { coinbase: 'ETH-USD', kraken: 'ETH/USD', simStartPaise: 3_50_000_00, simVolatility: 0.75 },
    enabled: false,
  },
  {
    symbol: 'SOL-INR',
    name: 'Solana',
    kind: 'LIVE_CRYPTO',
    tickSizePaise: 100, // ₹1
    lotSizeUnits: 1,
    qtyScale: 100, // 0.01 SOL
    priceBandBps: 500,
    feed: { coinbase: 'SOL-USD', kraken: 'SOL/USD', simStartPaise: 17_500_00, simVolatility: 0.9 },
    enabled: false,
  },
  {
    symbol: 'SIM-NIFTY',
    name: 'Simulated NIFTY index',
    kind: 'SIMULATED',
    tickSizePaise: 5,
    lotSizeUnits: 1,
    qtyScale: 1,
    priceBandBps: 500,
    feed: { simStartPaise: 25_000_00, simVolatility: 0.15 },
    enabled: false,
  },
  {
    symbol: 'SIM-RELIANCE',
    name: 'Simulated Reliance',
    kind: 'SIMULATED',
    tickSizePaise: 5,
    lotSizeUnits: 1,
    qtyScale: 1,
    priceBandBps: 500,
    feed: { simStartPaise: 1_400_00, simVolatility: 0.25 },
    enabled: false,
  },
  {
    symbol: 'SIM-TCS',
    name: 'Simulated TCS',
    kind: 'SIMULATED',
    tickSizePaise: 5,
    lotSizeUnits: 1,
    qtyScale: 1,
    priceBandBps: 500,
    feed: { simStartPaise: 3_500_00, simVolatility: 0.25 },
    enabled: false,
  },
];

export function getInstrument(symbol: string): InstrumentSpec {
  const i = INSTRUMENTS.find((x) => x.symbol === symbol);
  if (!i) throw new Error(`Unknown instrument ${symbol}`);
  return i;
}

/** Configurable USD→INR conversion for live crypto prices. A config value, not a live FX rate. */
export const DEFAULT_USD_INR = 88.0;
