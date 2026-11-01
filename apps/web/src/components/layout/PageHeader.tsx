import type { ComponentType, ReactNode } from 'react';

/** One consistent page title: gradient icon tile, title, a single short line of context, optional actions. */
export function PageHeader({
  icon: Icon,
  title,
  subtitle,
  actions,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="bg-brand grid size-10 shrink-0 place-items-center rounded-xl text-white shadow-[0_8px_24px_-10px_var(--accent)]">
        <Icon className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
