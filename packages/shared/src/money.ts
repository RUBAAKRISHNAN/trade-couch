/**
 * Money is always an integer number of paise (1 rupee = 100 paise).
 * Quantity is always an integer number of "units"; an instrument's qtyScale says how many
 * units make one whole coin/share (BTC qtyScale = 10_000, so 1 unit = 0.0001 BTC).
 *
 * We use plain JS numbers but assert they stay inside Number.MAX_SAFE_INTEGER (2^53 - 1),
 * which is ~9 × 10^15 paise = ₹90 lakh crore. Postgres stores them as BIGINT.
 */
export type Paise = number;
export type Units = number;

export function assertSafe(n: number, what = 'value'): number {
  if (!Number.isSafeInteger(n)) throw new RangeError(`${what} is not a safe integer: ${n}`);
  return n;
}

/** notional (paise) = price per whole unit (paise) × qty units / qtyScale. Exact because tick % qtyScale === 0. */
export function notional(pricePaise: Paise, qtyUnits: Units, qtyScale: number): Paise {
  const raw = pricePaise * qtyUnits;
  assertSafe(raw, 'price×qty');
  if (raw % qtyScale !== 0)
    throw new RangeError(`notional not integral: ${pricePaise}×${qtyUnits}/${qtyScale}`);
  return raw / qtyScale;
}

export function rupeesToPaise(rupees: number): Paise {
  return Math.round(rupees * 100);
}

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
export function formatINR(paise: Paise): string {
  return inr.format(paise / 100);
}

export function unitsToQty(units: Units, qtyScale: number): number {
  return units / qtyScale;
}

export function roundToTick(
  pricePaise: number,
  tick: number,
  mode: 'down' | 'up' | 'nearest' = 'nearest',
): Paise {
  const q = pricePaise / tick;
  const r = mode === 'down' ? Math.floor(q) : mode === 'up' ? Math.ceil(q) : Math.round(q);
  return r * tick;
}

/** Virtual starting balance: ₹1,00,000 */
export const STARTING_CASH_PAISE: Paise = 1_00_000_00;
