import type { Pool } from '@tradecore/shared/node';
import { AppError } from '../errors';

export interface InstrumentRow {
  symbol: string;
  name: string;
  kind: 'LIVE_CRYPTO' | 'SIMULATED';
  tick_size_paise: number;
  lot_size_units: number;
  qty_scale: number;
  price_band_bps: number;
  status: 'ACTIVE' | 'HALTED' | 'DISABLED';
  feed: Record<string, unknown>;
}

// Instruments change rarely; a 1-second cache saves a query per order while keeping halts near-instant.
const cache = new Map<string, { row: InstrumentRow; at: number }>();
const TTL_MS = 1000;

export async function getInstrumentRow(pool: Pool, symbol: string): Promise<InstrumentRow> {
  const hit = cache.get(symbol);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.row;
  const r = await pool.query<InstrumentRow>('SELECT * FROM instruments WHERE symbol = $1', [symbol]);
  const row = r.rows[0];
  if (!row || row.status === 'DISABLED')
    throw new AppError(404, 'UNKNOWN_SYMBOL', `Unknown instrument ${symbol}`);
  cache.set(symbol, { row, at: Date.now() });
  return row;
}

export async function listInstruments(pool: Pool): Promise<InstrumentRow[]> {
  return (
    await pool.query<InstrumentRow>(
      `SELECT * FROM instruments WHERE status <> 'DISABLED' ORDER BY kind, symbol`,
    )
  ).rows;
}

export function invalidateInstrument(symbol?: string) {
  if (symbol) cache.delete(symbol);
  else cache.clear();
}
