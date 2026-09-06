import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface EmptyStateProps {
  title: string;
  description?: ReactNode;
  /** Primary action, if there is something the operator can actually do here. */
  action?: ReactNode;
  icon?: ReactNode;
  /** `error` reframes the same layout for a failed request. */
  tone?: 'empty' | 'error';
  className?: string;
}

export function EmptyState({
  title,
  description,
  action,
  icon,
  tone = 'empty',
  className,
}: EmptyStateProps) {
  return (
    <div
      role={tone === 'error' ? 'alert' : undefined}
      className={cn(
        'flex flex-col items-center justify-center gap-2 px-6 py-14 text-center',
        className,
      )}
    >
      <div
        className={cn(
          'mb-1 flex h-9 w-9 items-center justify-center rounded-lg border',
          tone === 'error'
            ? 'border-danger/25 bg-danger-soft text-danger'
            : 'border-line bg-raised text-ink-subtle',
        )}
        aria-hidden="true"
      >
        {icon ?? (tone === 'error' ? <AlertGlyph /> : <BoxGlyph />)}
      </div>
      <p className="text-sm font-medium text-ink">{title}</p>
      {description && (
        <div className="max-w-sm text-xs leading-relaxed text-ink-muted">{description}</div>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

function BoxGlyph() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none">
      <path
        d="M2.5 5 8 2l5.5 3v6L8 14l-5.5-3V5Zm0 0L8 8m0 0 5.5-3M8 8v6"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function AlertGlyph() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none">
      <path
        d="M8 5.5v3.2M8 11.2h.01M6.8 2.6 1.7 11.4A1.4 1.4 0 0 0 2.9 13.5h10.2a1.4 1.4 0 0 0 1.2-2.1L9.2 2.6a1.4 1.4 0 0 0-2.4 0Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
