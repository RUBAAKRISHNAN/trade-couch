import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { motion } from 'framer-motion';
import { BookOpen, ChevronRight } from 'lucide-react';
import { Disclaimer } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Segmented,
} from '@/components/ui/primitives';
import { useInstruments, useSymbolStreams } from '@/hooks/data';
import { baseAsset, inr, price, qty as fmtQty } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useMarket } from '@/stores/market';
import { positionFromRisk, simulateOrder } from './simulate';

const LESSONS = [
  { id: 'book', title: 'The order book' },
  { id: 'orders', title: 'Order types — try one' },
  { id: 'priority', title: 'Who gets filled first' },
  { id: 'candles', title: 'Reading candles' },
  { id: 'pnl', title: 'Profit & loss' },
  { id: 'liquidity', title: 'Liquidity & market makers' },
  { id: 'risk', title: 'Risk: sizing a trade' },
] as const;

function Lesson({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <Card id={id} className="scroll-mt-16">
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm leading-relaxed">{children}</CardContent>
    </Card>
  );
}

function Term({ children }: { children: React.ReactNode }) {
  return <strong className="font-semibold text-foreground">{children}</strong>;
}

/** A compact, live 6-level view of the real TradeCore book with the spread called out. */
function LiveBook({ symbol, qtyScale }: { symbol: string; qtyScale: number }) {
  const book = useMarket((s) => s.books[symbol]);
  if (!book) return <p className="text-muted">Waiting for the live order book…</p>;
  const asks = book.asks.slice(0, 6).reverse();
  const bids = book.bids.slice(0, 6);
  const bestAsk = book.asks[0]?.price;
  const bestBid = book.bids[0]?.price;
  const spread = bestAsk && bestBid ? bestAsk - bestBid : null;
  const max = Math.max(1, ...asks.map((l) => l.qty), ...bids.map((l) => l.qty));
  const Row = ({ p, q, side, best }: { p: number; q: number; side: 'ask' | 'bid'; best: boolean }) => (
    <div className="relative flex justify-between px-2 py-0.5 font-mono text-xs">
      <div
        className={cn('absolute inset-y-0 right-0', side === 'ask' ? 'bg-sell-soft' : 'bg-buy-soft')}
        style={{ width: `${(q / max) * 100}%` }}
      />
      <span className={cn('relative', side === 'ask' ? 'text-sell' : 'text-buy', best && 'font-bold')}>
        {price(p)}
      </span>
      <span className="relative">{fmtQty(q, qtyScale)}</span>
    </div>
  );
  return (
    <div className="grid gap-3 md:grid-cols-[minmax(0,260px)_1fr]">
      <div className="rounded-lg border bg-panel-2/40 py-1" aria-label="Live order book">
        <p className="px-2 pb-1 text-[10px] uppercase tracking-wide text-sell">Sellers (asks)</p>
        {asks.map((l) => (
          <Row key={`a${l.price}`} p={l.price} q={l.qty} side="ask" best={l.price === bestAsk} />
        ))}
        <p className="my-1 border-y bg-panel px-2 py-1 text-center text-[11px] text-muted">
          spread {spread === null ? '—' : inr(spread)}
        </p>
        {bids.map((l) => (
          <Row key={`b${l.price}`} p={l.price} q={l.qty} side="bid" best={l.price === bestBid} />
        ))}
        <p className="px-2 pt-1 text-[10px] uppercase tracking-wide text-buy">Buyers (bids)</p>
      </div>
      <ul className="space-y-2 text-sm">
        <li>
          <Term>Ask</Term> — the lowest price a seller will accept right now:{' '}
          <span className="num text-sell">{price(bestAsk)}</span>.
        </li>
        <li>
          <Term>Bid</Term> — the highest price a buyer will pay right now:{' '}
          <span className="num text-buy">{price(bestBid)}</span>.
        </li>
        <li>
          <Term>Spread</Term> — the gap between them ({spread === null ? '—' : inr(spread)}). Nobody trades
          until a buyer and a seller agree on a price, so a trade happens only when an order crosses this gap.
        </li>
        <li className="text-muted">
          This is the real {baseAsset(symbol)} book on TradeCore, updating live. The bars show how much is
          waiting at each price.
        </li>
      </ul>
    </div>
  );
}

function OrderSimulator({ symbol, qtyScale, lot }: { symbol: string; qtyScale: number; lot: number }) {
  const book = useMarket((s) => s.books[symbol]);
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY');
  const [kind, setKind] = useState<'MARKET' | 'LIMIT'>('MARKET');
  const [q, setQ] = useState(String((lot * 20) / qtyScale));
  const [lim, setLim] = useState('');
  const units = Math.round(Number(q) * qtyScale);
  const limitPaise = kind === 'LIMIT' && lim ? Math.round(Number(lim) * 100) : null;
  const sim = useMemo(
    () => (book && units > 0 ? simulateOrder(book, side, units, qtyScale, limitPaise) : null),
    [book, side, units, qtyScale, limitPaise],
  );
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <div className="space-y-2">
        <div className="flex gap-2">
          <Segmented
            value={side}
            onChange={setSide}
            options={[
              { value: 'BUY', label: 'Buy' },
              { value: 'SELL', label: 'Sell' },
            ]}
          />
          <Segmented
            value={kind}
            onChange={setKind}
            options={[
              { value: 'MARKET', label: 'Market' },
              { value: 'LIMIT', label: 'Limit' },
            ]}
          />
        </div>
        <div>
          <Label htmlFor="sim-q">Quantity ({baseAsset(symbol)})</Label>
          <Input id="sim-q" inputMode="decimal" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {kind === 'LIMIT' && (
          <div>
            <Label htmlFor="sim-l">Limit price (₹)</Label>
            <Input
              id="sim-l"
              inputMode="decimal"
              placeholder={book ? (book[side === 'BUY' ? 'asks' : 'bids'][0]?.price ?? 0) / 100 + '' : ''}
              value={lim}
              onChange={(e) => setLim(e.target.value)}
            />
          </div>
        )}
        <p className="text-xs text-muted">
          {kind === 'MARKET'
            ? 'A market order says “now, at the best prices available”. It takes from the other side of the book until it is filled.'
            : `A limit order says “only at my price or better”. A ${side === 'BUY' ? 'buy' : 'sell'} limit fills against ${side === 'BUY' ? 'asks at or below' : 'bids at or above'} your price; the rest waits in the book.`}{' '}
          A <Term>stop-loss</Term> is a sell that only wakes up if the price falls to your stop price — it
          protects you when you’re not watching.
        </p>
      </div>
      <div className="rounded-lg border bg-panel-2/40 p-3 text-sm" aria-live="polite">
        <p className="mb-1 text-[11px] uppercase tracking-wide text-muted">What would happen right now</p>
        {!sim ? (
          <p className="text-muted">Enter a quantity.</p>
        ) : (
          <>
            {sim.fills.length ? (
              <ul className="space-y-0.5 font-mono text-xs">
                {sim.fills.map((f, i) => (
                  <li key={i}>
                    fill {fmtQty(f.qty, qtyScale)} @ {price(f.price)}
                  </li>
                ))}
              </ul>
            ) : (
              <p>No fill — no one is offering that price yet.</p>
            )}
            {sim.filledQty > 0 && (
              <p className="mt-2">
                Average price <span className="num font-semibold">{price(sim.avgPrice)}</span> · total{' '}
                <span className="num font-semibold">{inr(sim.cost)}</span>
                {sim.fills.length > 1 && (
                  <span className="text-muted">
                    {' '}
                    — it walked {sim.fills.length} price levels (that’s “slippage”).
                  </span>
                )}
              </p>
            )}
            {sim.remaining > 0 && (
              <p className="mt-1 text-warn">
                {fmtQty(sim.remaining, qtyScale)}{' '}
                {kind === 'LIMIT'
                  ? 'would wait in the book at your price'
                  : 'would be cancelled (not enough on the book)'}
              </p>
            )}
          </>
        )}
        <p className="mt-2 text-[11px] text-muted">A preview only — nothing is sent.</p>
      </div>
    </div>
  );
}

function CandleDiagram() {
  return (
    <svg
      viewBox="0 0 320 150"
      className="h-36 w-full max-w-sm"
      role="img"
      aria-label="Candle anatomy: green and red candles"
    >
      <g fontSize="10" fill="var(--muted)">
        <line x1="70" y1="15" x2="70" y2="135" stroke="var(--buy)" strokeWidth="2" />
        <rect x="55" y="40" width="30" height="65" fill="var(--buy)" rx="2" />
        <text x="95" y="18">
          High
        </text>
        <text x="95" y="44">
          Close
        </text>
        <text x="95" y="108">
          Open
        </text>
        <text x="95" y="138">
          Low
        </text>
        <line x1="230" y1="15" x2="230" y2="135" stroke="var(--sell)" strokeWidth="2" />
        <rect x="215" y="40" width="30" height="65" fill="var(--sell)" rx="2" />
        <text x="255" y="44">
          Open
        </text>
        <text x="255" y="108">
          Close
        </text>
        <text x="40" y="150" fill="var(--buy)">
          closed higher
        </text>
        <text x="200" y="150" fill="var(--sell)">
          closed lower
        </text>
      </g>
    </svg>
  );
}

function RiskCalculator() {
  const [equity, setEquity] = useState('100000');
  const [risk, setRisk] = useState('1');
  const [entry, setEntry] = useState('100');
  const [stop, setStop] = useState('98');
  const r = positionFromRisk(Number(equity), Number(risk), Number(entry), Number(stop));
  const field = (id: string, label: string, v: string, set: (s: string) => void) => (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} inputMode="decimal" value={v} onChange={(e) => set(e.target.value)} />
    </div>
  );
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <div className="grid grid-cols-2 gap-2">
        {field('r-eq', 'Your money (₹)', equity, setEquity)}
        {field('r-risk', 'Risk per trade (%)', risk, setRisk)}
        {field('r-entry', 'Entry price (₹)', entry, setEntry)}
        {field('r-stop', 'Stop-loss price (₹)', stop, setStop)}
      </div>
      <div className="rounded-lg border bg-panel-2/40 p-3" aria-live="polite">
        {r ? (
          <>
            <p>
              Buy{' '}
              <span className="num font-semibold">
                {r.coins.toLocaleString('en-IN', { maximumFractionDigits: 4 })}
              </span>{' '}
              units (worth{' '}
              <span className="num font-semibold">
                {inr(Math.round(r.positionValue * 100), { noDecimals: true })}
              </span>
              , {r.positionPct.toFixed(0)}% of your money).
            </p>
            <p className="mt-1">
              If your stop is hit you lose about{' '}
              <span className="num font-semibold text-sell">
                {inr(Math.round(r.riskAmount * 100), { noDecimals: true })}
              </span>{' '}
              — exactly the {risk}% you chose.
            </p>
            <p className="mt-2 text-xs text-muted">
              That’s the professional rule: decide the loss you accept first, then let the stop distance set
              the size. A tight stop allows a bigger position; a wide stop needs a smaller one. The Trade
              Coach grades this “risk to your stop”.
            </p>
          </>
        ) : (
          <p className="text-muted">The stop must be below the entry price.</p>
        )}
      </div>
    </div>
  );
}

export default function LearnPage() {
  const instruments = useInstruments().data ?? [];
  const [symbol, setSymbol] = useState('BTC-INR');
  const inst = instruments.find((i) => i.symbol === symbol) ?? instruments[0];
  useSymbolStreams(inst?.symbol ?? symbol);

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mx-auto max-w-6xl p-3">
      <div className="mb-3 flex flex-wrap items-start gap-3">
        <BookOpen className="mt-1 size-6 text-accent" />
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold">Learn how a market works</h1>
          <p className="text-sm text-muted">
            Seven short lessons, using TradeCore’s live market. You don’t need to know anything about trading
            to start.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted">Live market:</span>
          <select
            value={inst?.symbol ?? symbol}
            onChange={(e) => setSymbol(e.target.value)}
            className="h-8 rounded-md border bg-panel-2 px-2 text-sm"
          >
            {instruments.map((i) => (
              <option key={i.symbol} value={i.symbol}>
                {i.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="grid gap-3 lg:grid-cols-[200px_minmax(0,1fr)]">
        <nav aria-label="Lessons" className="hidden lg:block">
          <ol className="sticky top-3 space-y-0.5 text-sm">
            {LESSONS.map((l, i) => (
              <li key={l.id}>
                <a
                  href={`#${l.id}`}
                  className="flex items-center gap-2 rounded px-2 py-1.5 text-muted hover:bg-panel-2 hover:text-foreground"
                >
                  <span className="num text-xs">{i + 1}</span>
                  {l.title}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <div className="space-y-3">
          <Lesson id="book" title="1 · The order book">
            <p>
              An exchange is a marketplace where buyers and sellers meet. Everyone who wants to trade at a
              specific price waits in the <Term>order book</Term>: sellers on top, buyers below. The price is
              not set by anyone — it’s wherever buyers and sellers agree.
            </p>
            {inst && <LiveBook symbol={inst.symbol} qtyScale={inst.qtyScale} />}
          </Lesson>

          <Lesson id="orders" title="2 · Order types — try one">
            <p>
              Choose how you want to trade and see exactly what would fill against the live book. Bigger
              orders “walk” through several prices, so the average price gets worse.
            </p>
            {inst && <OrderSimulator symbol={inst.symbol} qtyScale={inst.qtyScale} lot={inst.lotSizeUnits} />}
          </Lesson>

          <Lesson id="priority" title="3 · Who gets filled first: price-time priority">
            <p>
              When your order arrives, TradeCore’s matching engine pairs it with waiting orders by two rules,
              exactly like NSE or BSE: <Term>best price first</Term>, and at the same price,{' '}
              <Term>first come, first served</Term>.
            </p>
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-xs">
                <thead className="bg-panel-2 text-left text-muted">
                  <tr>
                    <th className="px-2 py-1.5">Waiting sell orders</th>
                    <th className="px-2 py-1.5">Price</th>
                    <th className="px-2 py-1.5">Arrived</th>
                    <th className="px-2 py-1.5">A buy for 30 at market gets…</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  <tr className="border-t">
                    <td className="px-2 py-1.5">Asha · 20</td>
                    <td className="px-2 py-1.5">₹101</td>
                    <td className="px-2 py-1.5">10:00:01</td>
                    <td className="px-2 py-1.5 text-buy">all 20 (first at the best price)</td>
                  </tr>
                  <tr className="border-t">
                    <td className="px-2 py-1.5">Kumar · 30</td>
                    <td className="px-2 py-1.5">₹101</td>
                    <td className="px-2 py-1.5">10:00:05</td>
                    <td className="px-2 py-1.5 text-buy">10 (his other 20 keep waiting: a “partial fill”)</td>
                  </tr>
                  <tr className="border-t">
                    <td className="px-2 py-1.5">Ravi · 50</td>
                    <td className="px-2 py-1.5">₹102</td>
                    <td className="px-2 py-1.5">09:59:00</td>
                    <td className="px-2 py-1.5 text-muted">nothing — earlier, but a worse price</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Lesson>

          <Lesson id="candles" title="4 · Reading candles">
            <div className="grid items-center gap-3 md:grid-cols-2">
              <CandleDiagram />
              <p>
                Each candle summarises one period (1 minute, 1 hour, 1 day): where the price{' '}
                <Term>opened</Term>, its <Term>high</Term> and <Term>low</Term>, and where it{' '}
                <Term>closed</Term> — “OHLC”. Green means it closed higher than it opened, red means lower.
                TradeCore builds candles from its own trades.
              </p>
            </div>
          </Lesson>

          <Lesson id="pnl" title="5 · Profit & loss">
            <p>
              Buy 10 shares at ₹100 and the price rises to ₹110: you have <Term>+₹100 unrealised</Term> profit
              — on paper, it can still disappear. Sell them, and it becomes <Term>realised</Term>. Your{' '}
              <Term>equity</Term> is cash plus the current value of everything you hold.
            </p>
          </Lesson>

          <Lesson id="liquidity" title="6 · Liquidity & market makers">
            <p>
              <Term>Liquidity</Term> is how easily you can trade without moving the price — lots of orders
              close to the current price means good liquidity. <Term>Market makers</Term> keep it there by
              always quoting both a buy and a sell price, earning the small spread in between. On TradeCore,
              market-maker bots quote around the real live price, so you can always trade — and TradeCore’s
              price follows the real market.
            </p>
          </Lesson>

          <Lesson id="risk" title="7 · Risk: how big should a trade be?">
            <p>
              Most beginners lose money not because they pick bad trades but because one or two big losses
              wipe them out. The fix is to size every trade by the loss you can accept.
            </p>
            <RiskCalculator />
          </Lesson>

          <Card className="flex flex-col items-center gap-3 p-4 text-center sm:flex-row sm:text-left">
            <div className="flex-1">
              <p className="font-medium">Ready to practise?</p>
              <p className="text-sm text-muted">
                Place a trade with a stop and target — the Coach will grade how you did it.
              </p>
            </div>
            <Button asChild>
              <Link to="/trade">
                Go to Trade <ChevronRight />
              </Link>
            </Button>
          </Card>
          <Disclaimer className="text-center" />
        </div>
      </div>
    </motion.div>
  );
}
