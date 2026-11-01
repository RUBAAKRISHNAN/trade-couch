export interface Instrument {
  symbol: string;
  name: string;
  kind: 'LIVE_CRYPTO' | 'SIMULATED';
  status: 'ACTIVE' | 'HALTED' | 'DISABLED';
  tickSizePaise: number;
  lotSizeUnits: number;
  qtyScale: number;
  priceBandBps: number;
  refPrice: number | null;
  refSource: string | null;
  lastPrice: number | null;
}

export interface TickerRow {
  symbol: string;
  ref: number | null;
  source: string | null;
  last: number | null;
  open_24h: number | null;
  high_24h: number | null;
  low_24h: number | null;
  volume_24h: number;
  trades_24h: number;
}

export interface Order {
  id: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  type: 'LIMIT' | 'MARKET' | 'STOP_MARKET' | 'STOP_LIMIT';
  tif: 'GTC' | 'IOC' | 'FOK';
  qty: number;
  filled: number;
  price: number | null;
  stopPrice: number | null;
  avgFillPrice: number | null;
  status: 'PENDING' | 'OPEN' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELLED' | 'REJECTED';
  reason: string | null;
  planStop: number | null;
  planTarget: number | null;
  createdAt: string;
}

export interface Holding {
  symbol: string;
  name: string;
  qtyScale: number;
  qty: number;
  heldQty: number;
  avgCost: number | null;
  costBasis: number;
  price: number | null;
  marketValue: number;
  unrealizedPnl: number;
  realizedPnl: number;
}

export interface Portfolio {
  accountId: number;
  cash: number;
  cashHeld: number;
  cashAvailable: number;
  startingCash: number;
  marketValue: number;
  equity: number;
  totalPnl: number;
  totalReturnPct: number;
  realizedPnl: number;
  unrealizedPnl: number;
  holdings: Holding[];
}

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  ma20: number;
}

export interface MyTrade {
  id: number;
  symbol: string;
  price: number;
  qty: number;
  notional: number;
  side: 'BUY' | 'SELL';
  ts: string;
  taker: boolean;
}

export interface User {
  id: string;
  email: string;
  displayName: string;
  role: 'USER' | 'ADMIN';
}

export interface CoachWeek {
  week_start: string;
  skill_score: number;
  trades: number;
  win_rate: number | null;
  avg_win_paise: number | null;
  avg_loss_paise: number | null;
  max_drawdown_paise: number | null;
  habits: string[];
  goal: string;
  ai_summary: string | null;
}

export interface CoachSummary {
  accountId: number;
  current: CoachWeek | null;
  weeks: CoachWeek[];
  totals: {
    trips: number;
    avgScore: number | null;
    wins: number;
    pnl: number;
    grades: Record<string, number>;
  };
  flags: { flag: string; n: number }[];
  badges: {
    code: string;
    name: string;
    description: string;
    icon: string;
    earned: boolean;
    awarded_at: string | null;
  }[];
  openPositions: { symbol: string; qty: number; opened_at: string }[];
}

export interface CoachTrip {
  id: number;
  symbol: string;
  name: string;
  qty_scale: number;
  qty: number;
  entry_price: number;
  exit_price: number;
  pnl: number;
  equity_at_open: number;
  opened_at: string;
  closed_at: string;
  plan_stop: number | null;
  plan_target: number | null;
  had_stop_order: boolean;
  source: 'live' | 'seed';
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  score: number;
  flags: string[];
  tip: string;
  details: {
    sizePct: number;
    plannedRR: number | null;
    holdMinutes: number;
    moveBeforeEntryPct: number | null;
    returnPct: number;
  };
}
