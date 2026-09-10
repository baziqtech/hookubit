import type { Delivery } from '../../types/api';

/**
 * Whether the attempt history is HERE, NEVER WAS, or WAS RECLAIMED.
 *
 * `attempts_pruned_at` exists because the third case used to look like the
 * second: retention deletes the per-attempt rows — headers, bodies, timings,
 * which is where the bytes are — at 60 days while the summary row survives to
 * 90. Past that horizon a delivery reads `attempt_count: 5` beside an empty
 * attempt list, and a page that rendered "No attempts yet" over it would be
 * telling an operator the platform never tried, which is the opposite of what
 * happened.
 *
 * The rule reads the timestamp BEFORE the array, as the DTO's own doc says.
 * Rows that are still present win over the flag — if any attempts survive
 * they are shown, and the reclamation is noted rather than used to hide them.
 */
export type AttemptHistoryState =
  | { kind: 'present'; prunedAt: string | null }
  | { kind: 'none' }
  | { kind: 'pruned'; prunedAt: string; attemptCount: number };

export function attemptHistoryState(
  delivery: Pick<Delivery, 'attempts_pruned_at' | 'attempt_count'>,
  attempts: readonly unknown[],
): AttemptHistoryState {
  if (attempts.length > 0) return { kind: 'present', prunedAt: delivery.attempts_pruned_at };
  if (delivery.attempts_pruned_at !== null) {
    return {
      kind: 'pruned',
      prunedAt: delivery.attempts_pruned_at,
      attemptCount: delivery.attempt_count,
    };
  }
  return { kind: 'none' };
}

/** True when the status code and per-attempt error are gone for good. */
export function attemptsWerePruned(
  delivery: Pick<Delivery, 'attempts_pruned_at' | 'attempt_count'>,
  attempts: readonly unknown[],
): boolean {
  return attemptHistoryState(delivery, attempts).kind === 'pruned';
}
