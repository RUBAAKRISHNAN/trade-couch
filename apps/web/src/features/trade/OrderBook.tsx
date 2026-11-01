import { memo, useMemo } from 'react';
import {
  Card,
  CardHeader,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tip,
} from '@/components/ui/primitives';
import { useOrders } from '@/hooks/data';
import { price, qty, tickPrice } from '@/lib/format';
import type { Instrument } from '@/lib/types';
import { cn } from '@/lib/utils';
import { useMarket, type BookLevel } from '@/stores/market';
import { useUi } from '@/stores/ui';
import { DepthChart } from './DepthChart';
import { TradeTape } from './TradeTape';

const ROWS = 12;

type Row = BookLevel & { cum: number };

function withCumulative(levels: BookLevel[]): Row[] {
  let cum = 0;
  return levels.slice(0, ROWS).map((l) => ({ ...l, cum: (cum += l.qty) }));
}

const LevelRow = memo(function LevelRow({
  row,
  side,
  max,
  scale,
  tick,
  mine,
}: {
  row: Row;
  side: 'bid' | 'ask';
  max: number;
  scale: number;
  tick: number;
  mine: boolean;
}) {
  const setPrefill = useUi((s) => s.setPrefill);
  return (
    <button
      type="button"
      onClick={() => setPrefill(row.price)}
      title="Click to use this price in the order form"
      className="relative grid w-full grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)_minmax(0,1fr)] gap-2 cursor-pointer px-3 py-[3px] text-right text-xs hover:bg-panel-2"
    >
      {/* depth bar: how much total size sits at this level and better */}
      <span
        aria-hidden
        className={cn(
          'absolute inset-y-0 right-0 transition-[width] duration-200',
          side === 'bid' ? 'bg-buy-soft' : 'bg-sell-soft',
        )}
        style={{ width: `${(row.cum / max) * 100}%` }}
      />
      <span className={cn('num relative truncate text-left', side === 'bid' ? 'text-buy' : 'text-sell')}>
        {mine && (
          <span
            className="mr-1 inline-block size-1.5 rounded-full bg-accent align-middle"
            aria-label="your order"
          />
        )}
        {tickPrice(row.price, tick)}
      </span>
      <span className="num relative truncate">{qty(row.qty, scale)}</span>
      <span className="num relative truncate text-muted">{qty(row.cum, scale)}</span>
    </button>
  );
});

/**
 * ORDER BOOK: every open limit order, grouped by price.
 *  - Bids (green) = people wanting to BUY, best (highest) price on top of the bid side.
 *  - Asks (red)  = people wanting to SELL, best (lowest) price nearest the middle.
 *  - Spread = best ask − best bid. A small spread means a liquid market.
 */
export function OrderBookPanel({ inst }: { inst: Instrument }) {
  const book = useMarket((s) => s.books[inst.symbol]);
  const myOrders = useOrders('open').data;
  const myPrices = useMemo(
    () => new Set(myOrders?.filter((o) => o.symbol === inst.symbol && o.price).map((o) => o.price!)),
    [myOrders, inst.symbol],
  );
  const bids = useMemo(() => withCumulative(book?.bids ?? []), [book]);
  const asks = useMemo(() => withCumulative(book?.asks ?? []), [book]);
  const max = Math.max(bids.at(-1)?.cum ?? 0, asks.at(-1)?.cum ?? 0, 1);
  const bestBid = bids[0]?.price;
  const bestAsk = asks[0]?.price;
  const spread = bestBid && bestAsk ? bestAsk - bestBid : null;
  const mid = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : null;

  return (
    <Card className="flex h-full min-h-0 flex-col overflow-hidden">
      <Tabs defaultValue="book" className="flex min-h-0 flex-1 flex-col">
        <CardHeader>
          <TabsList>
            <TabsTrigger value="book">Order book</TabsTrigger>
            <TabsTrigger value="depth">Depth</TabsTrigger>
            <TabsTrigger value="trades" className="xl:hidden">
              Trades
            </TabsTrigger>
          </TabsList>
        </CardHeader>
        <TabsContent value="book" className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden">
          <div className="grid w-full grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)_minmax(0,1fr)] gap-2 px-3 py-1 text-right text-[10px] uppercase text-muted">
            <span className="text-left">Price ₹</span>
            <span>Size</span>
            <span>Total</span>
          </div>
          {!book ? (
            <div className="space-y-1 p-3">
              {Array.from({ length: 10 }, (_, i) => (
                <Skeleton key={i} className="h-4" />
              ))}
            </div>
          ) : (
            <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-auto">
              <div className="flex flex-col-reverse">
                {asks.map((r) => (
                  <LevelRow
                    key={r.price}
                    row={r}
                    side="ask"
                    max={max}
                    scale={inst.qtyScale}
                    tick={inst.tickSizePaise}
                    mine={myPrices.has(r.price)}
                  />
                ))}
              </div>
              <Tip content="Spread = best ask − best bid. Buying at market costs you the ask; selling gets you the bid. Tighter spread = more liquid market.">
                <div className="flex items-center justify-between gap-2 whitespace-nowrap border-y bg-panel-2/60 px-3 py-1.5 text-xs">
                  <span className="num font-semibold">{mid ? `₹${price(Math.round(mid))}` : '—'}</span>
                  <span className="text-muted">
                    Spread{' '}
                    <span className="num text-foreground">{spread != null ? `₹${price(spread)}` : '—'}</span>
                    {spread != null && mid ? (
                      <span className="num hidden 2xl:inline">
                        {' '}
                        ({((spread / mid) * 10_000).toFixed(1)} bps)
                      </span>
                    ) : null}
                  </span>
                </div>
              </Tip>
              {bids.map((r) => (
                <LevelRow
                  key={r.price}
                  row={r}
                  side="bid"
                  max={max}
                  scale={inst.qtyScale}
                  tick={inst.tickSizePaise}
                  mine={myPrices.has(r.price)}
                />
              ))}
              {book.bids.length === 0 && book.asks.length === 0 && (
                <p className="p-4 text-center text-xs text-muted">
                  The book is empty. Waiting for market makers…
                </p>
              )}
            </div>
          )}
        </TabsContent>
        <TabsContent value="depth" className="min-h-0 flex-1 data-[state=inactive]:hidden">
          <DepthChart inst={inst} />
        </TabsContent>
        <TabsContent value="trades" className="min-h-0 flex-1 data-[state=inactive]:hidden">
          <TradeTape inst={inst} bare />
        </TabsContent>
      </Tabs>
    </Card>
  );
}
