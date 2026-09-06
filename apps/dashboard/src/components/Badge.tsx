import type { ReactNode } from 'react';
import { cn } from '../lib/cn';
import { deliveryStatusMeta, eventStatusMeta, type StatusTone } from '../lib/delivery-status';
import type { DeliveryStatus, EventStatus } from '../types/api';

const TONES: Record<StatusTone, string> = {
  ok: 'bg-ok-soft text-ok border-ok/25',
  warn: 'bg-warn-soft text-warn border-warn/25',
  danger: 'bg-danger-soft text-danger border-danger/25',
  info: 'bg-info-soft text-info border-info/25',
  neutral: 'bg-raised text-ink-muted border-line-strong/60',
};

const DOTS: Record<StatusTone, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  danger: 'bg-danger',
  info: 'bg-info',
  neutral: 'bg-ink-subtle',
};

export interface BadgeProps {
  tone?: StatusTone;
  /** Leading status dot — scannable down a column of hundreds of rows. */
  dot?: boolean;
  /** Colour alone never carries the meaning; the label always does. */
  children: ReactNode;
  className?: string;
  /** Set for statuses still in motion, e.g. `processing`. */
  pulse?: boolean;
}

export function Badge({ tone = 'neutral', dot = false, pulse, children, className }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded border px-1.5 py-0.5',
        'text-2xs font-medium leading-none',
        TONES[tone],
        className,
      )}
    >
      {dot && (
        <span
          aria-hidden="true"
          className={cn('h-1.5 w-1.5 shrink-0 rounded-full', DOTS[tone], pulse && 'animate-pulse')}
        />
      )}
      {children}
    </span>
  );
}

/**
 * The delivery-state badge. Tone and label both come from
 * `lib/delivery-status`, so the nine states are coloured in one place and
 * `failed` (retries pending) never renders identically to `exhausted` (dead).
 */
export function DeliveryStatusBadge({
  status,
  className,
}: {
  status: DeliveryStatus;
  className?: string;
}) {
  const meta = deliveryStatusMeta(status);
  return (
    <Badge tone={meta.tone} dot pulse={meta.phase === 'in_flight'} className={className}>
      {meta.label}
    </Badge>
  );
}

export function EventStatusBadge({
  status,
  className,
}: {
  status: EventStatus;
  className?: string;
}) {
  const meta = eventStatusMeta(status);
  return (
    <Badge tone={meta.tone} dot pulse={meta.phase === 'in_flight'} className={className}>
      {meta.label}
    </Badge>
  );
}
