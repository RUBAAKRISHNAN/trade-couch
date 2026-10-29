import { memo, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Badge, Card, CardHeader, CardTitle, Skeleton } from '@/components/ui/primitives';
import { useInstruments, useTicker } from '@/hooks/data';
import { pct, price } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useMarket } from '@/stores/market';

/** Remembers the previous value so a change can trigger a green/red flash. */
export function useFlash(value: number | null | undefined) {
  const prev = useRef(value);
  const [flash, setFlash] = useState<{ dir: 'up' | 'down'; key: number } | null>(null);
  useEffect(() => {
    if (value != null && prev.current != null && value !== prev.current)
      setFlash((f) => ({ dir: value > prev.current! ? 'up' : 'down', key: (f?.key ?? 0) + 1 }));
    prev.current = value;
  }, [value]);
  return flash;
}

const Row = memo(function Row({
  symbol,
  name,
  kind,
  active,
  open24h,
}: {
  symbol: string;
  name: string;
  kind: string;
  active: boolean;
  open24h: number | null;
}) {
  const navigate = useNavigate();
  const tick = useMarket((s) => s.ticks[symbol]);
  const p = tick?.price ?? null;
  const flash = useFlash(p);
  const change = p && open24h ? ((p - open24h) / open24h) * 100 : null;
  return (
    <button
      type="button"
      onClick={() => navigate(`/trade/${symbol}`)}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'grid w-full cursor-pointer grid-cols-[1fr_auto] items-center gap-x-2 px-3 py-2 text-left transition-colors hover:bg-panel-2',
        active && 'bg-panel-2',
      )}
    >
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          {symbol}
          {kind === 'SIMULATED' && <Badge>sim</Badge>}
        </span>
        <span className="block truncate text-[11px] text-muted">{name}</span>
      </span>
      <span className="text-right">
        <span
          key={flash?.key}
          className={cn(
            'num block rounded px-1 text-sm',
            flash && (flash.dir === 'up' ? 'flash-up' : 'flash-down'),
          )}
        >
          {price(p)}
        </span>
        <span
          className={cn(
            'num block text-[11px]',
            change == null ? 'text-muted' : change >= 0 ? 'text-buy' : 'text-sell',
          )}
        >
          {pct(change)}
        </span>
      </span>
    </button>
  );
});

export function Watchlist({ active }: { active: string }) {
  const { data, isLoading } = useInstruments();
  const ticker = useTicker();
  const open = new Map(ticker.data?.map((t) => [t.symbol, t.open_24h]) ?? []);
  return (
    <Card className="flex h-full min-h-0 flex-col">
      <CardHeader>
        <CardTitle>Markets</CardTitle>
        <span className="text-[10px] text-muted">₹ · 24h</span>
      </CardHeader>
      <div className="scroll-thin min-h-0 flex-1 overflow-auto py-1">
        {isLoading &&
          Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="px-3 py-2">
              <Skeleton className="h-8" />
            </div>
          ))}
        {data?.map((i) => (
          <Row
            key={i.symbol}
            symbol={i.symbol}
            name={i.name}
            kind={i.kind}
            active={i.symbol === active}
            open24h={open.get(i.symbol) ?? null}
          />
        ))}
      </div>
    </Card>
  );
}
