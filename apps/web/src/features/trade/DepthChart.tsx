import { useMemo } from 'react';
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { price, qty } from '@/lib/format';
import type { Instrument } from '@/lib/types';
import { useMarket } from '@/stores/market';

/**
 * DEPTH CHART: cumulative size available at each price. The left (green) wall is total buying interest
 * at or above each price; the right (red) wall is total selling interest at or below it.
 * Steep walls near the middle = deep, liquid market: big orders move the price less.
 */
export function DepthChart({ inst }: { inst: Instrument }) {
  const book = useMarket((s) => s.books[inst.symbol]);
  const data = useMemo(() => {
    if (!book) return [];
    let c = 0;
    const bids = book.bids
      .map((l) => ({ price: l.price, bid: (c += l.qty), ask: null as number | null }))
      .reverse();
    c = 0;
    const asks = book.asks.map((l) => ({ price: l.price, ask: (c += l.qty), bid: null as number | null }));
    return [...bids, ...asks];
  }, [book]);

  if (!data.length)
    return <p className="grid h-full place-items-center p-4 text-xs text-muted">No depth yet.</p>;
  return (
    <div className="h-full min-h-48 p-2" role="img" aria-label="Market depth chart">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 4, left: 4, bottom: 0 }}>
          <XAxis
            dataKey="price"
            type="number"
            domain={['dataMin', 'dataMax']}
            tickFormatter={(p) => price(p)}
            tick={{ fontSize: 10, fill: 'var(--muted)' }}
            stroke="var(--border)"
          />
          <YAxis hide />
          <Tooltip
            contentStyle={{
              background: 'var(--panel)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              fontSize: 12,
            }}
            labelFormatter={(p) => `₹${price(Number(p))}`}
            formatter={(v, name) => [
              `${qty(Number(v), inst.qtyScale)}`,
              name === 'bid' ? 'Cumulative bids' : 'Cumulative asks',
            ]}
          />
          <Area
            type="stepAfter"
            dataKey="bid"
            stroke="var(--buy)"
            fill="var(--buy-soft)"
            strokeWidth={1.5}
            isAnimationActive={false}
            connectNulls={false}
          />
          <Area
            type="stepBefore"
            dataKey="ask"
            stroke="var(--sell)"
            fill="var(--sell-soft)"
            strokeWidth={1.5}
            isAnimationActive={false}
            connectNulls={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
