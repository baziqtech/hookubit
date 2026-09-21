import type { OutboxEntry } from '../../types/api';

/**
 * "Why did this park?" — as pure data, because it is the sentence the outbox
 * page exists to say and the one thing on it worth testing without a DOM.
 *
 * The router parks a row for exactly four reasons (`internal/router/router.go`,
 * `park(...)`), and it writes `last_error` as `"<reason>: <detail>"`. The
 * reason is therefore RECOVERABLE from the text, and that is read first — but
 * it is a prefix on a free-text field rather than a column, so the counters
 * are the fallback and the two are never allowed to disagree silently: when
 * the prefix is missing the verdict is inferred from `unaccounted_attempts`
 * and `failing_since`, which is what the router itself decided on.
 *
 * The distinction that changes what an operator does next is the first two:
 *
 *   - `attempts_exhausted` — claims that ended with the router writing NOTHING.
 *     A crash, an OOM kill, a lease left to lapse. This is the poison signal:
 *     the event itself is probably what the router cannot survive, and
 *     requeueing it without looking at the payload will park it again.
 *   - `retry_duration_exceeded` — every failure was RECORDED. The router
 *     understood what went wrong and wrote it down, over and over, for longer
 *     than the retry window. That is the shape of a database outage that
 *     outlasted the hour, not a bad event; once the outage is over a requeue is
 *     the whole fix.
 */
export type ParkReason =
  | 'attempts_exhausted'
  | 'retry_duration_exceeded'
  | 'unknown_outbox_type'
  | 'event_missing'
  | 'unknown';

/** Whether pressing Requeue is likely to help, so the button can say so. */
export type RequeueOutlook = 'safe' | 'caution' | 'futile';

export interface ParkedExplanation {
  reason: ParkReason;
  /** One line, for the row. */
  headline: string;
  /** What it means and who probably owns it. */
  detail: string;
  /** The numbers behind the verdict, phrased. */
  evidence: string[];
  /** True when `fan_out_cursor` says some endpoints already have their delivery. */
  partial: boolean;
  outlook: RequeueOutlook;
}

const KNOWN_REASONS: readonly ParkReason[] = [
  'attempts_exhausted',
  'retry_duration_exceeded',
  'unknown_outbox_type',
  'event_missing',
];

/**
 * The reason, from the prefix the router wrote, or inferred from the counters.
 *
 * Inference order matters and mirrors `router.go`: the unaccounted bound is
 * checked BEFORE the time bound there, so a row that trips both is a poison
 * row here too.
 */
export function parkReasonOf(
  entry: Pick<OutboxEntry, 'last_error' | 'unaccounted_attempts' | 'failing_since'>,
): ParkReason {
  const prefix = /^([a-z_]+):/.exec(entry.last_error ?? '')?.[1];
  if (prefix && (KNOWN_REASONS as readonly string[]).includes(prefix)) {
    return prefix as ParkReason;
  }
  if (entry.unaccounted_attempts > 0) return 'attempts_exhausted';
  if (entry.failing_since) return 'retry_duration_exceeded';
  return 'unknown';
}

/** "3 claims" — never "3 claim". */
function claims(n: number): string {
  return `${n} claim${n === 1 ? '' : 's'}`;
}

export function explainParked(
  entry: Pick<
    OutboxEntry,
    | 'type'
    | 'attempts'
    | 'unaccounted_attempts'
    | 'failing_since'
    | 'fan_out_cursor'
    | 'last_error'
    | 'processed_at'
  >,
): ParkedExplanation {
  const reason = parkReasonOf(entry);
  const partial = entry.fan_out_cursor !== null;
  const evidence: string[] = [];

  // The two counters are ALWAYS stated together, because the ratio between
  // them is the diagnosis: 11 of 11 unaccounted is a row that kills the
  // process; 0 of 63 is a row the router understood every single time.
  evidence.push(
    `${claims(entry.attempts)} in total, ${entry.unaccounted_attempts} of them ending with nothing recorded`,
  );

  switch (reason) {
    case 'attempts_exhausted':
      return {
        reason,
        headline: 'The router kept dying on this event',
        detail:
          'Every one of the unaccounted claims ended without the router writing an outcome — a crash, an out-of-memory kill or a lease left to lapse. That is the signature of an event the router cannot survive, not of an outage. Look at the payload before requeueing: put back unchanged, it will most likely park again after another round of crashes.',
        evidence,
        partial,
        outlook: 'caution',
      };
    case 'retry_duration_exceeded':
      return {
        reason,
        headline: 'Kept failing for longer than the retry window',
        detail:
          'Every failure was recorded, which means the router understood what went wrong each time — the database or a subscription lookup was erroring under it, not the event itself. This is what an outage that outlasted the retry window looks like. Once the cause is fixed, requeueing is the whole recovery.',
        evidence: entry.failing_since
          ? [...evidence, `failing continuously since ${entry.failing_since}`]
          : evidence,
        partial,
        outlook: 'safe',
      };
    case 'unknown_outbox_type':
      return {
        reason,
        headline: `The router does not handle "${entry.type}" rows`,
        detail:
          'The row asks for something this router has no code path for, so it was parked on sight rather than claimed forever. Requeueing changes nothing until a router that understands this type is deployed.',
        evidence,
        partial,
        outlook: 'futile',
      };
    case 'event_missing':
      return {
        reason,
        headline: 'The event this row points at no longer exists',
        detail:
          'There is nothing to fan out. Requeueing will park it again for the same reason; this row is evidence of a deleted or lost event, not work to recover.',
        evidence,
        partial,
        outlook: 'futile',
      };
    case 'unknown':
      return {
        reason,
        headline: 'Parked, and the router did not say why',
        detail:
          'The row is parked but its last error carries no recognised reason. Read the raw error before deciding; if it is empty, the row may have been parked by hand.',
        evidence,
        partial,
        outlook: 'caution',
      };
  }
}

/** Only a parked row can be requeued — the API answers 409 to anything else. */
export function isParked(entry: Pick<OutboxEntry, 'status'>): boolean {
  return entry.status === 'failed';
}

/**
 * How many of a set of parked rows are beyond recovery by requeueing.
 *
 * `futile` is not "probably will not work" — it is the two reasons where
 * putting the row back CANNOT change the outcome: no router handles that kind
 * of row, or the event it points at is gone. Those rows will be claimed, fail
 * for the identical reason, and park again, having produced a fresh burst of
 * nothing.
 *
 * Counting them BEFORE the action is the difference between a bulk requeue that
 * is a recovery and one that is a ritual. Someone who knows two of their five
 * rows can never move goes and fixes the router first; someone who does not
 * presses the button every hour and concludes the platform is broken.
 *
 * Returns null when there is nothing to warn about, so the caller renders
 * nothing rather than an all-clear — the common case must cost no space.
 */
export function futileSummary(
  entries: ReadonlyArray<Parameters<typeof explainParked>[0]>,
): { count: number; total: number; ids: string[] } | null {
  const futile = entries.filter((entry) => explainParked(entry).outlook === 'futile');
  if (futile.length === 0) return null;
  return {
    count: futile.length,
    total: entries.length,
    // Only ever used to NAME a couple of them; the caller truncates.
    ids: futile.map((entry) => (entry as { id?: string }).id ?? '').filter(Boolean),
  };
}
