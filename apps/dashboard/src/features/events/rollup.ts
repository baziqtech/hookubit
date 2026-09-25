import type { EventDeliveryRollup } from '../../types/api';

export type RollupTone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral';

export interface RollupSummary {
  label: string;
  tone: RollupTone;
  /** The actual mix, spelled out. Never a paraphrase of `label`. */
  detail: string;
}

const LABELS: Record<string, { label: string; tone: RollupTone }> = {
  received: { label: 'Received', tone: 'neutral' },
  in_progress: { label: 'In progress', tone: 'info' },
  delivered: { label: 'Delivered', tone: 'ok' },
  partly_delivered: { label: 'Partly delivered', tone: 'warn' },
  all_failed: { label: 'All failed', tone: 'danger' },
  dropped: { label: 'Dropped', tone: 'danger' },
};

/**
 * The event's deliveries, in a badge and a sentence.
 *
 * ## Why the detail is a mix and not a restatement
 *
 * "Partly delivered" tells you something went wrong and nothing about what.
 * "1 delivered · 1 cancelled" tells you the endpoint was paused; "1 delivered
 * · 1 failed" tells you it was not. Those lead to different next clicks, and
 * the difference costs one string.
 *
 * ## Dropped gets a sentence rather than a count
 *
 * There is nothing to count — that IS the state. The sentence says what
 * happened, because "0 deliveries" reads as a number that has not arrived yet
 * rather than as a routing decision that has already been made.
 */
export function describeRollup(rollup: EventDeliveryRollup | null | undefined): RollupSummary {
  if (!rollup) {
    // The list computes this; the detail route does not. A missing rollup is
    // "not asked for", never "nothing happened".
    return { label: 'Received', tone: 'neutral', detail: '—' };
  }

  const known = LABELS[rollup.state] ?? { label: rollup.state, tone: 'neutral' as RollupTone };

  return { ...known, detail: detailFor(rollup) };
}

function detailFor(rollup: EventDeliveryRollup): string {
  if (rollup.state === 'dropped') return 'No subscription matched — nothing was created';
  if (rollup.state === 'received') return 'Creating deliveries…';
  if (rollup.total === 0) return '—';

  // Settled and uniform: the ratio is the whole story and the parts are noise.
  if (rollup.state === 'delivered') return `${rollup.total} of ${rollup.total} delivered`;
  if (rollup.state === 'all_failed' && rollup.cancelled === 0) {
    return `0 of ${rollup.total} delivered`;
  }

  const parts: string[] = [];
  if (rollup.succeeded > 0) parts.push(`${rollup.succeeded} delivered`);
  if (rollup.in_flight > 0) parts.push(`${rollup.in_flight} still going`);
  if (rollup.failed > 0) parts.push(`${rollup.failed} failed`);
  if (rollup.cancelled > 0) parts.push(`${rollup.cancelled} cancelled`);
  return parts.join(' · ');
}
