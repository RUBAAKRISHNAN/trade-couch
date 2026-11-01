/** Display helpers. Server values are integers: paise for money, units for quantity. */

const inr2 = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const inr0 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const num2 = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** ₹1,23,456.78 */
export function inr(
  paise: number | null | undefined,
  opts: { compact?: boolean; noDecimals?: boolean } = {},
): string {
  if (paise === null || paise === undefined || Number.isNaN(paise)) return '—';
  const r = paise / 100;
  if (opts.compact && Math.abs(r) >= 1e5) {
    if (Math.abs(r) >= 1e7) return `₹${(r / 1e7).toFixed(2)} Cr`;
    return `₹${(r / 1e5).toFixed(2)} L`;
  }
  return opts.noDecimals ? inr0.format(r) : inr2.format(r);
}

/** 1,23,456.78 (price without the ₹ sign, for dense tables) */
export function price(paise: number | null | undefined): string {
  if (paise === null || paise === undefined) return '—';
  return num2.format(paise / 100);
}

const int0 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
/**
 * Price for dense tables: drops the paise when the instrument only moves in whole rupees (BTC's tick is ₹100,
 * so "68,75,700.00" → "68,75,700"), which keeps narrow columns from overflowing.
 */
export function tickPrice(paise: number | null | undefined, tickPaise: number): string {
  if (paise === null || paise === undefined) return '—';
  return tickPaise % 100 === 0 ? int0.format(paise / 100) : price(paise);
}

export function signedInr(paise: number): string {
  return `${paise > 0 ? '+' : paise < 0 ? '−' : ''}${inr(Math.abs(paise))}`;
}

export function pct(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const shown = Math.abs(v).toFixed(digits);
  // a value that rounds to zero gets no sign (no "−0.00%")
  const sign = Number(shown) === 0 ? '' : v > 0 ? '+' : '−';
  return `${sign}${shown}%`;
}

/** decimals to show for a quantity, from the instrument's qtyScale (10_000 → 4) */
export function qtyDecimals(qtyScale: number): number {
  return Math.round(Math.log10(qtyScale));
}

/** units → "0.0012" */
export function qty(units: number | null | undefined, qtyScale: number): string {
  if (units === null || units === undefined) return '—';
  const d = qtyDecimals(qtyScale);
  return (units / qtyScale).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** user input "0.0012" → units, or null if it isn't a whole number of units */
export function parseQty(input: string, qtyScale: number): number | null {
  const n = Number(input);
  if (!input.trim() || !Number.isFinite(n) || n <= 0) return null;
  const units = Math.round(n * qtyScale);
  return Math.abs(units / qtyScale - n) < 1e-9 && units > 0 ? units : null;
}

/** user input "7130000.50" (rupees) → paise snapped to the tick */
export function parsePrice(input: string, tickPaise: number): number | null {
  const n = Number(input);
  if (!input.trim() || !Number.isFinite(n) || n <= 0) return null;
  return Math.max(tickPaise, Math.round((n * 100) / tickPaise) * tickPaise);
}

export function rupeesString(paise: number): string {
  return (paise / 100).toFixed(2);
}

export function timeHMS(ts: number | string | Date): string {
  return new Date(ts).toLocaleTimeString('en-IN', { hour12: false });
}

/** BTC-INR → BTC; simulated instruments drop their prefix: SIM-RELIANCE → RELIANCE. */
export function baseAsset(symbol: string) {
  if (symbol.startsWith('SIM-')) return symbol.slice(4);
  return symbol.split('-')[0] ?? symbol;
}
