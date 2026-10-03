import { Badge } from '../../components';
import { cn } from '../../lib/cn';
import { formatRelativeTime, formatTimestamp } from '../../lib/format';
import type { OutboxEntry } from '../../types/api';
import { explainParked, type RequeueOutlook } from './parked';

const OUTLOOK_LABEL: Record<RequeueOutlook, string> = {
  safe: 'requeue should recover it',
  caution: 'requeue may park it again',
  futile: 'requeue will not help',
};

const OUTLOOK_TONE: Record<RequeueOutlook, 'ok' | 'warn' | 'danger'> = {
  safe: 'ok',
  caution: 'warn',
  futile: 'danger',
};

/**
 * "Why did this park?" — in the operator's terms, then the router's.
 *
 * Headline first, then the two counters phrased as a sentence, then the raw
 * `last_error` verbatim. The raw string is never paraphrased away: it is what
 * gets pasted into the incident thread, and it is the only thing on the row
 * that the router itself wrote.
 */
export function ParkedExplanation({
  entry,
  compact = false,
}: {
  entry: OutboxEntry;
  /** Row form: no outlook sentence, tighter spacing. */
  compact?: boolean;
}) {
  const explanation = explainParked(entry);
  const parkedAt = entry.processed_at;

  return (
    <div
      data-testid="parked-explanation"
      data-park-reason={explanation.reason}
      className={cn('flex flex-col', compact ? 'gap-1' : 'gap-1.5')}
    >
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-xs font-medium text-ink">{explanation.headline}</span>
        <Badge tone={OUTLOOK_TONE[explanation.outlook]}>{OUTLOOK_LABEL[explanation.outlook]}</Badge>
        {explanation.partial && <Badge tone="warn">routing partly done</Badge>}
      </p>

      {!compact && (
        <p className="max-w-3xl text-xs leading-relaxed text-ink-muted">{explanation.detail}</p>
      )}

      <p className="text-2xs text-ink-subtle">
        {explanation.evidence.join(' · ')}
        {parkedAt && (
          <>
            {' · '}
            <span title={formatTimestamp(parkedAt)}>parked {formatRelativeTime(parkedAt)}</span>
          </>
        )}
      </p>

      {explanation.partial && !compact && (
        <p className="text-2xs leading-relaxed text-ink-subtle">
          Some endpoints already have their delivery for this event; the rest are still owed one.
          A requeue resumes from subscription{' '}
          <code className="font-mono">{entry.routing_cursor}</code> rather than re-sending to
          endpoints it already reached.
        </p>
      )}

      {entry.last_error && (
        <p className="overflow-x-auto rounded border border-line bg-panel px-2 py-1 font-mono text-2xs text-ink">
          {entry.last_error}
        </p>
      )}
    </div>
  );
}
