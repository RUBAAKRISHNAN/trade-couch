import { AnimatePresence, motion } from 'framer-motion';
import { Card, CardHeader, CardTitle, Tip } from '@/components/ui/primitives';
import { price, qty, timeHMS } from '@/lib/format';
import type { Instrument } from '@/lib/types';
import { cn } from '@/lib/utils';
import { useMarket } from '@/stores/market';

/** TRADE TAPE ("time & sales"): every trade matched on our exchange. Green = buyer was the aggressor. */
export function TradeTape({ inst, bare }: { inst: Instrument; bare?: boolean }) {
  const tape = useMarket((s) => s.tape[inst.symbol]) ?? [];
  const body = (
    <>
      <div className="grid grid-cols-3 px-3 py-1 text-right text-[10px] uppercase text-muted">
        <span className="text-left">Price ₹</span>
        <span>Size</span>
        <span>Time</span>
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-auto" aria-live="off">
        <AnimatePresence initial={false}>
          {tape.slice(0, 50).map((t) => (
            <motion.div
              key={t.seq}
              layout="position"
              initial={{
                opacity: 0,
                backgroundColor: t.side === 'BUY' ? 'var(--buy-soft)' : 'var(--sell-soft)',
              }}
              animate={{ opacity: 1, backgroundColor: 'rgba(0,0,0,0)' }}
              transition={{ duration: 0.8 }}
              className="grid grid-cols-3 px-3 py-[3px] text-right text-xs"
            >
              <span className={cn('num text-left', t.side === 'BUY' ? 'text-buy' : 'text-sell')}>
                {price(t.price)}
              </span>
              <span className="num">{qty(t.qty, inst.qtyScale)}</span>
              <span className="num text-muted">{timeHMS(t.ts)}</span>
            </motion.div>
          ))}
        </AnimatePresence>
        {tape.length === 0 && <p className="p-4 text-center text-xs text-muted">No trades yet.</p>}
      </div>
    </>
  );
  if (bare) return <div className="flex h-full min-h-0 flex-col">{body}</div>;
  return (
    <Card className="flex h-full min-h-0 flex-col">
      <CardHeader>
        <Tip content="Time & sales: each row is one trade our matching engine executed. Green means a buyer crossed the spread (bought at the ask); red means a seller hit the bid.">
          <CardTitle>Trades</CardTitle>
        </Tip>
      </CardHeader>
      {body}
    </Card>
  );
}
