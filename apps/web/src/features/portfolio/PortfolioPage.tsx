import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { Area, AreaChart, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle, Skeleton, Tip } from '@/components/ui/primitives';
import { useInstruments, useMyTrades, usePortfolio } from '@/hooks/data';
import { api } from '@/lib/api';
import { baseAsset, inr, pct, price, qty, signedInr } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useMarket } from '@/stores/market';

const PALETTE = ['#7c74ff', '#16c784', '#f5a524', '#3fa9f5', '#f0465a', '#b07cff', '#8a93a6'];

function StatCard({
  label,
  value,
  sub,
  tone,
  tip,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'buy' | 'sell';
  tip?: string;
}) {
  const body = (
    <Card className="p-3">
      <p className="text-[11px] uppercase tracking-wide text-muted">{label}</p>
      <p
        className={cn(
          'num mt-1 text-xl font-semibold',
          tone === 'buy' && 'text-buy',
          tone === 'sell' && 'text-sell',
        )}
      >
        {value}
      </p>
      {sub && <p className="num mt-0.5 text-xs text-muted">{sub}</p>}
    </Card>
  );
  return tip ? <Tip content={tip}>{body}</Tip> : body;
}

export default function PortfolioPage() {
  const { data: pf, isLoading } = usePortfolio();
  const trades = useMyTrades();
  const instruments = useInstruments().data;
  const scaleOf = (sym: string) => instruments?.find((i) => i.symbol === sym)?.qtyScale ?? 1;
  const ticks = useMarket((s) => s.ticks);
  const equity = useQuery({
    queryKey: ['portfolio', 'equity'],
    queryFn: () => api<{ time: number; equity: number }[]>('/portfolio/equity'),
  });

  if (isLoading || !pf)
    return (
      <div className="grid gap-3 p-3 md:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
    );

  // live re-valuation from streaming reference prices
  const holdings = pf.holdings
    .filter((h) => h.qty > 0)
    .map((h) => {
      const p = ticks[h.symbol]?.price ?? h.price ?? 0;
      const value = Math.round((p * h.qty) / h.qtyScale);
      return { ...h, livePrice: p, value, upnl: value - h.costBasis };
    });
  const mv = holdings.reduce((s, h) => s + h.value, 0);
  const eq = pf.cash + mv;
  const totalPnl = eq - pf.startingCash;
  const upnl = holdings.reduce((s, h) => s + h.upnl, 0);
  const alloc = [
    { name: 'Cash', value: pf.cash },
    ...holdings.map((h) => ({ name: baseAsset(h.symbol), value: h.value })),
  ].filter((x) => x.value > 0);

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mx-auto max-w-7xl space-y-3 p-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard
          label="Equity"
          value={inr(eq)}
          sub={`started with ${inr(pf.startingCash, { noDecimals: true })}`}
          tip="Equity = cash + current value of everything you hold."
        />
        <StatCard
          label="Total P&L"
          value={signedInr(totalPnl)}
          sub={pct((totalPnl / pf.startingCash) * 100)}
          tone={totalPnl >= 0 ? 'buy' : 'sell'}
        />
        <StatCard
          label="Unrealised P&L"
          value={signedInr(upnl)}
          tone={upnl >= 0 ? 'buy' : 'sell'}
          tip="Profit or loss on positions you still hold, at today's price. It only becomes real (realised) when you sell."
        />
        <StatCard
          label="Realised P&L"
          value={signedInr(pf.realizedPnl)}
          tone={pf.realizedPnl >= 0 ? 'buy' : 'sell'}
          tip="Profit or loss locked in by selling, measured against your average cost."
        />
        <StatCard label="Cash" value={inr(pf.cash)} sub={`${inr(pf.cashHeld)} reserved for open orders`} />
        <StatCard label="Available to trade" value={inr(pf.cashAvailable)} />
        <StatCard
          label="Invested"
          value={inr(mv)}
          sub={`${holdings.length} position${holdings.length === 1 ? '' : 's'}`}
        />
        <StatCard
          label="Return"
          value={pct((totalPnl / pf.startingCash) * 100)}
          tone={totalPnl >= 0 ? 'buy' : 'sell'}
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-[2fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Equity curve</CardTitle>
          </CardHeader>
          <CardContent className="h-64">
            {equity.data && equity.data.length > 1 ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={equity.data}>
                  <defs>
                    <linearGradient id="eq" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis
                    dataKey="time"
                    type="number"
                    domain={['dataMin', 'dataMax']}
                    tickFormatter={(t) =>
                      new Date(t * 1000).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
                    }
                    tick={{ fontSize: 10, fill: 'var(--muted)' }}
                    stroke="var(--border)"
                  />
                  <YAxis
                    domain={['auto', 'auto']}
                    tickFormatter={(v) => inr(v, { compact: true })}
                    tick={{ fontSize: 10, fill: 'var(--muted)' }}
                    stroke="var(--border)"
                    width={70}
                  />
                  <Tooltip
                    contentStyle={{
                      background: 'var(--panel)',
                      border: '1px solid var(--border)',
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                    labelFormatter={(t) => new Date(Number(t) * 1000).toLocaleString('en-IN')}
                    formatter={(v) => [inr(Number(v)), 'Equity']}
                  />
                  <Area
                    type="monotone"
                    dataKey="equity"
                    stroke="var(--accent)"
                    fill="url(#eq)"
                    strokeWidth={2}
                    isAnimationActive={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <p className="grid h-full place-items-center text-sm text-muted">
                Your equity curve appears after a little trading history.
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Allocation</CardTitle>
          </CardHeader>
          <CardContent className="flex h-64 items-center gap-3">
            <ResponsiveContainer width="55%" height="100%">
              <PieChart>
                <Pie
                  data={alloc}
                  dataKey="value"
                  nameKey="name"
                  innerRadius="60%"
                  outerRadius="90%"
                  paddingAngle={2}
                  stroke="none"
                  isAnimationActive={false}
                >
                  {alloc.map((_, i) => (
                    <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{
                    background: 'var(--panel)',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  formatter={(v) => inr(Number(v))}
                />
              </PieChart>
            </ResponsiveContainer>
            <ul className="space-y-1.5 text-xs">
              {alloc.map((a, i) => (
                <li key={a.name} className="flex items-center gap-2">
                  <span className="size-2.5 rounded-sm" style={{ background: PALETTE[i % PALETTE.length] }} />
                  <span>{a.name}</span>
                  <span className="num text-muted">{((a.value / eq) * 100).toFixed(1)}%</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Holdings</CardTitle>
        </CardHeader>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="text-left text-[11px] uppercase text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Asset</th>
                <th className="text-right font-medium">Quantity</th>
                <th className="text-right font-medium">Avg cost</th>
                <th className="text-right font-medium">Price</th>
                <th className="text-right font-medium">Value</th>
                <th className="text-right font-medium">Unrealised</th>
                <th className="px-3 text-right font-medium">Realised</th>
              </tr>
            </thead>
            <tbody>
              {holdings.map((h) => (
                <tr key={h.symbol} className="border-t">
                  <td className="px-3 py-2">
                    <span className="font-medium">{h.symbol}</span>{' '}
                    <span className="text-xs text-muted">{h.name}</span>
                  </td>
                  <td className="num text-right">{qty(h.qty, h.qtyScale)}</td>
                  <td className="num text-right">{price(h.avgCost)}</td>
                  <td className="num text-right">{price(h.livePrice)}</td>
                  <td className="num text-right">{inr(h.value)}</td>
                  <td className={cn('num text-right', h.upnl >= 0 ? 'text-buy' : 'text-sell')}>
                    {signedInr(h.upnl)}
                  </td>
                  <td className={cn('num px-3 text-right', h.realizedPnl >= 0 ? 'text-buy' : 'text-sell')}>
                    {signedInr(h.realizedPnl)}
                  </td>
                </tr>
              ))}
              {!holdings.length && (
                <tr>
                  <td colSpan={7} className="p-6 text-center text-sm text-muted">
                    You hold only cash. Head to Trade to make your first (virtual) trade.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Trade history</CardTitle>
        </CardHeader>
        <div className="scroll-thin max-h-96 overflow-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="sticky top-0 bg-panel text-left text-[11px] uppercase text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Time</th>
                <th className="font-medium">Symbol</th>
                <th className="font-medium">Side</th>
                <th className="text-right font-medium">Price</th>
                <th className="text-right font-medium">Quantity</th>
                <th className="text-right font-medium">Value</th>
                <th className="px-3 text-right font-medium">Role</th>
              </tr>
            </thead>
            <tbody>
              {trades.data?.map((t) => (
                <tr key={t.id} className="border-t">
                  <td className="num px-3 py-1.5 text-xs text-muted">
                    {new Date(t.ts).toLocaleString('en-IN', { hour12: false })}
                  </td>
                  <td>{t.symbol}</td>
                  <td className={t.side === 'BUY' ? 'text-buy' : 'text-sell'}>{t.side}</td>
                  <td className="num text-right">{price(t.price)}</td>
                  <td className="num text-right">{qty(t.qty, scaleOf(t.symbol))}</td>
                  <td className="num text-right">{inr(t.notional)}</td>
                  <td className="px-3 text-right text-xs text-muted">
                    <Tip
                      content={
                        t.taker
                          ? 'Taker: your order crossed the spread and took liquidity.'
                          : 'Maker: your resting order provided liquidity.'
                      }
                    >
                      <span>{t.taker ? 'taker' : 'maker'}</span>
                    </Tip>
                  </td>
                </tr>
              ))}
              {!trades.data?.length && (
                <tr>
                  <td colSpan={7} className="p-6 text-center text-sm text-muted">
                    No trades yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </motion.div>
  );
}
