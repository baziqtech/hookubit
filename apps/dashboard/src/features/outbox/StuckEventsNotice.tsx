import { Link } from 'react-router-dom';
import { cn } from '../../lib/cn';
import { useOutboxEntries } from './api';
import { stuckEventsSummary } from './stuck-summary';

/**
 * "Some events in this project produced nothing, and they are over there."
 *
 * ## Why this exists
 *
 * Publishing has two stages and each fails on its own. Fan-out turns one event
 * into one delivery per matching subscription; sending attempts each of those.
 * The delivery history is stage two, and it is where everyone looks.
 *
 * When stage one is stuck there is NOTHING in that history to see, because the
 * delivery rows were never created. The publisher was answered 202 and the
 * event went nowhere. So the operator filters for the event, finds an empty
 * result, and cannot tell that apart from "never published" or "filtered
 * wrong" — while the screen holding the answer sits behind a navigation item
 * named after a database table they have no reason to open.
 *
 * This closes that path from the two screens people are actually on.
 *
 * ## It is silent unless it is not
 *
 * Most projects have nothing stuck, most of the time, so the common case must
 * cost nothing: no reserved space, no zero count, no "all clear" to read past.
 * It renders `null` while loading and `null` when the count is zero — a late
 * panel is better than a wrong one, and an empty one is just furniture.
 *
 * `status: 'failed'` is the parked set specifically: rows the platform
 * accepted and then could not fan out. A row that is merely `pending` is work
 * in flight and nobody needs telling about it.
 */
export function StuckEventsNotice({
  orgId,
  projectId,
  className,
}: {
  orgId: string;
  projectId: string;
  className?: string;
}) {
  const parked = useOutboxEntries(projectId, { status: 'failed' }, 0);
  const summary = stuckEventsSummary(parked.data);

  // Silent while loading and silent when nothing is stuck. See `stuck-summary`.
  if (!summary) return null;

  return (
    <div
      role="status"
      className={cn(
        'flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-[0.625rem] border border-warn/30',
        'bg-warn-soft px-3.5 py-2.5 text-xs text-warn',
        className,
      )}
    >
      <span className="font-semibold">
        {summary.atLeast ? 'At least ' : ''}
        {summary.count} {summary.noun} {summary.verb} accepted but never fanned out.
      </span>
      <span className="text-ink-muted">
        {summary.pronoun} no deliveries to show here, or only some of them.
      </span>
      <Link
        to={`/orgs/${orgId}/projects/${projectId}/outbox`}
        className="font-medium text-accent underline-offset-2 hover:underline"
      >
        Show stuck events
      </Link>
    </div>
  );
}
