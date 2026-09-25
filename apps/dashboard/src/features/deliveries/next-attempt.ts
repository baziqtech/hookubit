import { formatRelativeTime } from '../../lib/format';
import type { Delivery } from '../../types/api';

/**
 * The "next attempt" cell, gated on `terminal` BEFORE it reads the timestamp.
 *
 * `next_attempt_at` is becoming NOT NULL (ADR-0007; `services/data-plane/
 * HANDOFF.md`, item 7). The data plane already writes `now()` on every
 * terminal transition, so a succeeded delivery carries a `next_attempt_at`
 * that has no scheduling meaning — status alone keeps it out of the ready set.
 * A cell that rendered the column ungated would read "2 minutes ago" against a
 * delivery that will never be attempted again, which is a retry the page
 * promised and the platform will not make.
 *
 * The non-terminal null case is worded from the DTO: null means "as soon as a
 * worker is free", not "unknown".
 */
export function nextAttemptLabel(
  delivery: Pick<Delivery, 'terminal' | 'next_attempt_at'>,
  now: Date = new Date(),
): string {
  if (delivery.terminal) return 'None';
  if (delivery.next_attempt_at === null) return 'When a worker is free';
  return formatRelativeTime(delivery.next_attempt_at, now);
}
