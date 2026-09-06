import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface PanelProps {
  title?: ReactNode;
  description?: ReactNode;
  /** Right-hand controls in the panel header. */
  actions?: ReactNode;
  children: ReactNode;
  /** Removes body padding, for panels whose content is a full-bleed table. */
  flush?: boolean;
  className?: string;
}

export function Panel({ title, description, actions, children, flush, className }: PanelProps) {
  return (
    <section
      className={cn(
        'overflow-hidden rounded-lg border border-line bg-panel shadow-panel',
        className,
      )}
    >
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
          <div className="min-w-0">
            {title && <h2 className="truncate text-xs font-semibold text-ink">{title}</h2>}
            {description && <p className="mt-0.5 text-xs text-ink-muted">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={flush ? undefined : 'p-4'}>{children}</div>
    </section>
  );
}

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Rendered above the title — IDs, status badges, breadcrumb tail. */
  eyebrow?: ReactNode;
  className?: string;
}

export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
  className,
}: PageHeaderProps) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-3', className)}>
      <div className="min-w-0">
        {eyebrow && <div className="mb-1 flex items-center gap-2 text-xs">{eyebrow}</div>}
        <h1 className="truncate text-base font-semibold tracking-tight text-ink">{title}</h1>
        {description && <p className="mt-1 text-xs text-ink-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export interface StatProps {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'default' | 'ok' | 'warn' | 'danger';
}

const STAT_TONES = {
  default: 'text-ink',
  ok: 'text-ok',
  warn: 'text-warn',
  danger: 'text-danger',
} as const;

export function Stat({ label, value, hint, tone = 'default' }: StatProps) {
  return (
    <div className="rounded-lg border border-line bg-panel px-3.5 py-3 shadow-panel">
      <p className="text-2xs font-medium uppercase tracking-wider text-ink-subtle">{label}</p>
      <p className={cn('mt-1.5 text-xl font-semibold tabular tracking-tight', STAT_TONES[tone])}>
        {value}
      </p>
      {hint && <p className="mt-0.5 text-xs text-ink-muted">{hint}</p>}
    </div>
  );
}
