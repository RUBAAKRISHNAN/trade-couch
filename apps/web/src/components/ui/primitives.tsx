import * as React from 'react';
import * as LabelPrimitive from '@radix-ui/react-label';
import * as SliderPrimitive from '@radix-ui/react-slider';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/* ── Card ───────────────────────────────────────────────── */
export function Card({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('rounded-xl border bg-panel/90 shadow-card backdrop-blur-sm', className)} {...p} />
  );
}
export function CardHeader({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('flex items-center justify-between gap-2 border-b px-4 py-2.5', className)} {...p} />
  );
}
export function CardTitle({ className, ...p }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn('text-[13px] font-semibold text-foreground/90', className)} {...p} />;
}
export function CardContent({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-4', className)} {...p} />;
}

/* ── Input / Label ──────────────────────────────────────── */
export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...p }, ref) => (
    <input
      ref={ref}
      className={cn(
        'flex h-9 w-full rounded-md border bg-panel-2 px-3 text-sm outline-none transition-colors placeholder:text-muted focus:border-accent disabled:opacity-50 aria-[invalid=true]:border-sell',
        className,
      )}
      {...p}
    />
  ),
);
Input.displayName = 'Input';

export const Label = React.forwardRef<
  React.ComponentRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
>(({ className, ...p }, ref) => (
  <LabelPrimitive.Root ref={ref} className={cn('text-xs font-medium text-muted', className)} {...p} />
));
Label.displayName = 'Label';

/* ── Badge ──────────────────────────────────────────────── */
const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
  {
    variants: {
      variant: {
        default: 'bg-panel-2 text-muted',
        buy: 'bg-buy-soft text-buy',
        sell: 'bg-sell-soft text-sell',
        warn: 'bg-warn/15 text-warn',
        accent: 'bg-accent/15 text-accent',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);
export function Badge({
  className,
  variant,
  ...p
}: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...p} />;
}

/* ── Skeleton ───────────────────────────────────────────── */
export function Skeleton({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('animate-pulse rounded bg-panel-2', className)} aria-hidden {...p} />;
}

/* ── Tabs ───────────────────────────────────────────────── */
export const Tabs = TabsPrimitive.Root;
export const TabsList = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...p }, ref) => (
  <TabsPrimitive.List ref={ref} className={cn('inline-flex items-center gap-1', className)} {...p} />
));
TabsList.displayName = 'TabsList';
export const TabsTrigger = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...p }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      'cursor-pointer rounded px-2 py-1 text-xs font-medium text-muted transition-colors hover:text-foreground data-[state=active]:bg-panel-2 data-[state=active]:text-foreground',
      className,
    )}
    {...p}
  />
));
TabsTrigger.displayName = 'TabsTrigger';
export const TabsContent = TabsPrimitive.Content;

/* ── Tooltip ────────────────────────────────────────────── */
export const TooltipProvider = TooltipPrimitive.Provider;
export function Tip({
  content,
  children,
  side = 'top',
}: {
  content: React.ReactNode;
  children: React.ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
}) {
  return (
    <TooltipPrimitive.Root delayDuration={200}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className="z-50 max-w-xs rounded-md border bg-panel px-2.5 py-1.5 text-xs leading-relaxed text-foreground shadow-lg"
        >
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

/* ── Slider ─────────────────────────────────────────────── */
export const Slider = React.forwardRef<
  React.ComponentRef<typeof SliderPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root> & { tone?: 'buy' | 'sell' }
>(({ className, tone = 'buy', ...p }, ref) => (
  <SliderPrimitive.Root
    ref={ref}
    className={cn('relative flex h-5 w-full touch-none select-none items-center', className)}
    {...p}
  >
    <SliderPrimitive.Track className="relative h-1 w-full grow overflow-hidden rounded-full bg-panel-2">
      <SliderPrimitive.Range className={cn('absolute h-full', tone === 'buy' ? 'bg-buy' : 'bg-sell')} />
    </SliderPrimitive.Track>
    <SliderPrimitive.Thumb
      aria-label="Quantity as % of available"
      className={cn(
        'block size-3.5 rounded-full border-2 bg-panel shadow transition-transform hover:scale-110',
        tone === 'buy' ? 'border-buy' : 'border-sell',
      )}
    />
  </SliderPrimitive.Root>
));
Slider.displayName = 'Slider';

/* ── Segmented control (shadcn "toggle group" style) ────── */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
  size = 'sm',
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: React.ReactNode; title?: string }[];
  className?: string;
  size?: 'sm' | 'xs';
}) {
  return (
    <div role="radiogroup" className={cn('inline-flex rounded-md bg-panel-2 p-0.5', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cn(
            'cursor-pointer rounded font-medium text-muted transition-colors hover:text-foreground',
            size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-1.5 py-0.5 text-[11px]',
            value === o.value && 'bg-panel text-foreground shadow-sm',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ── Keyboard hint ──────────────────────────────────────── */
export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded border bg-panel-2 px-1 font-mono text-[10px] text-muted">{children}</kbd>;
}
