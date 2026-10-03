import { useId, useState } from 'react';
import { Badge } from './Badge';
import { DELIVERY_STATUS_SENTENCE, deliveryStatusMeta } from '../lib/delivery-status';
import type { DeliveryStatus } from '../types/api';

/**
 * The nine delivery states, each as a plain-English sentence.
 *
 * `scheduled` vs `retrying` vs `exhausted` vs `cancelled` is not guessable, and
 * a badge that says "Exhausted" in red communicates severity without ever
 * communicating meaning. This is where the meaning lives.
 *
 * Collapsed by default with a real `<details>`: an operator who already knows
 * the model should not have to scroll past a glossary on every visit, and one
 * who does not should not have to leave for the docs. `<details>` gives
 * keyboard operation, the open/closed state and screen-reader semantics for
 * free — a hand-rolled disclosure would be more code and worse.
 */
const ORDER: DeliveryStatus[] = [
  'pending',
  'queued',
  'processing',
  'scheduled',
  'retrying',
  'failed',
  'succeeded',
  'exhausted',
  'cancelled',
];

export interface StatusLegendProps {
  /** Highlighted as the one currently filtered on, if any. */
  highlight?: DeliveryStatus | '';
  className?: string;
}

export function StatusLegend({ highlight, className }: StatusLegendProps) {
  const [open, setOpen] = useState(false);
  const id = useId();

  return (
    <details
      className={className}
      open={open}
      onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
    >
      <summary
        className="cursor-pointer list-none rounded px-1 py-0.5 text-xs text-ink-muted transition-colors hover:text-ink"
        aria-controls={id}
      >
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="text-ink-subtle">
            {open ? '▾' : '▸'}
          </span>
          What do these statuses mean?
        </span>
      </summary>

      <dl id={id} className="mt-2 grid gap-x-4 gap-y-2 sm:grid-cols-2 xl:grid-cols-3">
        {ORDER.map((status) => {
          const meta = deliveryStatusMeta(status);
          return (
            <div
              key={status}
              className={
                status === highlight
                  ? 'rounded-md border border-accent/40 bg-accent-soft/40 px-2 py-1.5'
                  : 'px-2 py-1.5'
              }
            >
              <dt className="flex items-center gap-1.5">
                <Badge tone={meta.tone} dot>
                  {meta.label}
                </Badge>
                {meta.terminal && (
                  <span className="text-2xs text-ink-subtle">final</span>
                )}
              </dt>
              <dd className="mt-1 text-2xs leading-relaxed text-ink-muted">
                {DELIVERY_STATUS_SENTENCE[status]}
              </dd>
            </div>
          );
        })}
      </dl>
    </details>
  );
}
