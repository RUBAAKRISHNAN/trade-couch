import { useMutation, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Badge,
  Card,
  CardHeader,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/primitives';
import { useInstruments, useOrders, usePortfolio } from '@/hooks/data';
import { api, ApiError } from '@/lib/api';
import { baseAsset, inr, pct, price, qty, signedInr } from '@/lib/format';
import type { Order } from '@/lib/types';
import { cn } from '@/lib/utils';
import { useMarket } from '@/stores/market';

const STATUS_VARIANT: Record<Order['status'], 'default' | 'buy' | 'sell' | 'warn' | 'accent'> = {
  PENDING: 'warn',
  OPEN: 'accent',
  PARTIALLY_FILLED: 'accent',
  FILLED: 'buy',
  CANCELLED: 'default',
  REJECTED: 'sell',
};

function useScale() {
  const inst = useInstruments().data;
  return (symbol: string) => inst?.find((i) => i.symbol === symbol)?.qtyScale ?? 1;
}

function OrdersTable({ orders, cancellable }: { orders: Order[]; cancellable?: boolean }) {
  const qc = useQueryClient();
  const scale = useScale();
  const cancel = useMutation({
    mutationFn: (id: number) => api(`/orders/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast('Cancel requested');
      setTimeout(() => void qc.invalidateQueries({ queryKey: ['orders'] }), 300);
    },
    onError: (e) =>
      toast.error('Could not cancel', { description: e instanceof ApiError ? e.message : undefined }),
  });
  if (!orders.length)
    return (
      <p className="p-6 text-center text-sm text-muted">
        {cancellable ? 'No open orders.' : 'No orders yet.'}
      </p>
    );
  return (
    <table className="w-full text-xs">
      <thead className="sticky top-0 bg-panel text-left text-[10px] uppercase text-muted">
        <tr>
          <th className="px-3 py-1.5 font-medium">Time</th>
          <th className="font-medium">Symbol</th>
          <th className="font-medium">Side</th>
          <th className="font-medium">Type</th>
          <th className="text-right font-medium">Price</th>
          <th className="text-right font-medium">Filled / Qty</th>
          <th className="text-right font-medium">Avg fill</th>
          <th className="px-3 text-right font-medium">Status</th>
          {cancellable && <th className="w-8" />}
        </tr>
      </thead>
      <tbody>
        {orders.map((o) => (
          <tr key={o.id} className="border-t hover:bg-panel-2/60">
            <td className="num px-3 py-1.5 text-muted">
              {new Date(o.createdAt).toLocaleTimeString('en-IN', { hour12: false })}
            </td>
            <td>{o.symbol}</td>
            <td className={o.side === 'BUY' ? 'text-buy' : 'text-sell'}>{o.side}</td>
            <td className="text-muted">
              {o.type.replace('_', ' ').toLowerCase()} · {o.tif}
            </td>
            <td className="num text-right">
              {o.price ? price(o.price) : o.stopPrice ? `stop ${price(o.stopPrice)}` : 'market'}
            </td>
            <td className="num text-right">
              {qty(o.filled, scale(o.symbol))} / {qty(o.qty, scale(o.symbol))}
            </td>
            <td className="num text-right">{price(o.avgFillPrice)}</td>
            <td className="px-3 text-right">
              <Badge variant={STATUS_VARIANT[o.status]} title={o.reason ?? undefined}>
                {o.status.replace('_', ' ')}
              </Badge>
            </td>
            {cancellable && (
              <td className="pr-2">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6"
                  onClick={() => cancel.mutate(o.id)}
                  aria-label={`Cancel order ${o.id}`}
                >
                  <X />
                </Button>
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Positions() {
  const { data, isLoading } = usePortfolio();
  const ticks = useMarket((s) => s.ticks);
  if (isLoading) return <Skeleton className="m-3 h-16" />;
  const rows = data?.holdings.filter((h) => h.qty > 0) ?? [];
  if (!rows.length)
    return <p className="p-6 text-center text-sm text-muted">No positions. Buy something to open one.</p>;
  return (
    <table className="w-full text-xs">
      <thead className="text-left text-[10px] uppercase text-muted">
        <tr>
          <th className="px-3 py-1.5 font-medium">Symbol</th>
          <th className="text-right font-medium">Qty</th>
          <th className="text-right font-medium">Avg cost</th>
          <th className="text-right font-medium">Price</th>
          <th className="text-right font-medium">Value</th>
          <th className="px-3 text-right font-medium">Unrealised P&amp;L</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((h) => {
          // live valuation from the streaming reference price
          const p = ticks[h.symbol]?.price ?? h.price ?? 0;
          const value = Math.round((p * h.qty) / h.qtyScale);
          const upnl = value - h.costBasis;
          return (
            <tr key={h.symbol} className="border-t">
              <td className="px-3 py-1.5">{h.symbol}</td>
              <td className="num text-right">
                {qty(h.qty, h.qtyScale)} {baseAsset(h.symbol)}
              </td>
              <td className="num text-right">{price(h.avgCost)}</td>
              <td className="num text-right">{price(p)}</td>
              <td className="num text-right">{inr(value)}</td>
              <td className={cn('num px-3 text-right', upnl >= 0 ? 'text-buy' : 'text-sell')}>
                {signedInr(upnl)}{' '}
                <span className="text-muted">({pct((upnl / Math.max(1, h.costBasis)) * 100)})</span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function AccountTabs() {
  const open = useOrders('open');
  const all = useOrders('all');
  const qc = useQueryClient();
  const cancelAll = useMutation({
    mutationFn: () => api('/orders', { method: 'DELETE' }),
    onSuccess: () => {
      toast('Cancelling all open orders');
      setTimeout(() => void qc.invalidateQueries({ queryKey: ['orders'] }), 400);
    },
  });
  return (
    <Card className="flex h-full min-h-0 flex-col">
      <Tabs defaultValue="open" className="flex min-h-0 flex-1 flex-col">
        <CardHeader>
          <TabsList>
            <TabsTrigger value="open">
              Open orders {open.data?.length ? `(${open.data.length})` : ''}
            </TabsTrigger>
            <TabsTrigger value="positions">Positions</TabsTrigger>
            <TabsTrigger value="history">Order history</TabsTrigger>
          </TabsList>
          {!!open.data?.length && (
            <Button variant="ghost" size="sm" onClick={() => cancelAll.mutate()}>
              Cancel all
            </Button>
          )}
        </CardHeader>
        <div className="scroll-thin min-h-0 flex-1 overflow-auto">
          <TabsContent value="open">
            {open.isLoading ? (
              <Skeleton className="m-3 h-16" />
            ) : (
              <OrdersTable orders={open.data ?? []} cancellable />
            )}
          </TabsContent>
          <TabsContent value="positions">
            <Positions />
          </TabsContent>
          <TabsContent value="history">
            {all.isLoading ? <Skeleton className="m-3 h-16" /> : <OrdersTable orders={all.data ?? []} />}
          </TabsContent>
        </div>
      </Tabs>
    </Card>
  );
}
