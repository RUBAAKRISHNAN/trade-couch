import { Badge, Tip } from '@/components/ui/primitives';
import { useTicker } from '@/hooks/data';
import { pct, price, qty } from '@/lib/format';
import type { Instrument } from '@/lib/types';
import { cn } from '@/lib/utils';
import { useMarket } from '@/stores/market';
import { useFlash } from './Watchlist';

export function MarketHeader({ inst }: { inst: Instrument }) {
  const tick = useMarket((s) => s.ticks[inst.symbol]);
  const book = useMarket((s) => s.books[inst.symbol]);
  const t = useTicker().data?.find((x) => x.symbol === inst.symbol);
  const ref = tick?.price ?? inst.refPrice;
  const last = book?.lastPrice ?? t?.last ?? inst.lastPrice;
  const flash = useFlash(ref);
  const change = ref && t?.open_24h ? ((ref - t.open_24h) / t.open_24h) * 100 : null;
  const source = tick?.source ?? inst.refSource;
  const live = source && source !== 'simulated';

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-1 rounded-lg border bg-panel px-3 py-2">
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-base font-semibold">{inst.symbol}</h1>
          {book?.halted && <Badge variant="sell">Halted</Badge>}
          <Tip
            content={
              live
                ? `Reference price from the live ${source} feed (USD, converted to ₹ at a configured rate). TradeCore runs its own order book; our prices track this reference.`
                : 'Simulated reference price (random walk). Used for practice instruments and whenever live feeds are unreachable.'
            }
          >
            <Badge variant={live ? 'buy' : 'warn'}>{live ? `live · ${source}` : 'simulated'}</Badge>
          </Tip>
        </div>
        <p className="text-[11px] text-muted">{inst.name}</p>
      </div>
      <div>
        <p className="text-[10px] uppercase text-muted">Reference</p>
        <p
          key={flash?.key}
          className={cn(
            'num rounded px-1 text-lg font-semibold',
            flash && (flash.dir === 'up' ? 'flash-up text-buy' : 'flash-down text-sell'),
          )}
        >
          ₹{price(ref)}
        </p>
      </div>
      <Stat
        label="Last trade"
        value={`₹${price(last)}`}
        tip="The price of the most recent trade matched on TradeCore's own order book."
      />
      <Stat
        label="24h change"
        value={pct(change)}
        className={change == null ? '' : change >= 0 ? 'text-buy' : 'text-sell'}
      />
      <Stat label="24h high" value={price(t?.high_24h)} />
      <Stat label="24h low" value={price(t?.low_24h)} />
      <Stat
        label="24h volume"
        value={t ? `${qty(Number(t.volume_24h), inst.qtyScale)} ${inst.symbol.split('-')[0]}` : '—'}
      />
    </div>
  );
}

function Stat({
  label,
  value,
  className,
  tip,
}: {
  label: string;
  value: string;
  className?: string;
  tip?: string;
}) {
  const body = (
    <div>
      <p className="text-[10px] uppercase text-muted">{label}</p>
      <p className={cn('num text-sm', className)}>{value}</p>
    </div>
  );
  return tip ? <Tip content={tip}>{body}</Tip> : body;
}
