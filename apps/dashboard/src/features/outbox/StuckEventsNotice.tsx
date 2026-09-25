import { Link } from 'react-router-dom';
import { cn } from '../../lib/cn';
import { useOutboxEntries } from './api';
import { stuckEventsState } from './stuck-summary';

/**
 * "Some events in this project produced nothing, and they are over there."
 *
 * ## Why this exists
 *
 * Publishing has two stages and each fails on its own. Routing turns one event
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
 * ## Three states, because it is now the main door
 *
 * Most projects have nothing stuck, most of the time, so the common case must
 * cost nothing: no reserved space, no zero count, no "all clear" to read past.
 * It renders `null` while loading and `null` when the count is zero — a late
 * panel is better than a wrong one, and an empty one is just furniture.
 *
 * `status: 'failed'` is the parked set specifically: rows the platform
 * accepted and then could not route. A row that is merely `pending` is work
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
  const state = stuckEventsState(parked.data, parked.isError);
  const to = `/orgs/${orgId}/projects/${projectId}/outbox`;

  if (state.kind === 'silent') return null;

  // Could not find out. Said quietly, because it is not itself bad news — but
  // said, because this notice is the way to that screen and silence here would
  // read as "nothing is stuck" at the one moment the project is misbehaving.
  if (state.kind === 'unknown') {
    return (
      <div
        role="status"
        className={cn(
          'flex flex-wrap items-baseline gap-x-2 rounded-[0.625rem] border border-line',
          'bg-raised px-3.5 py-2.5 text-xs text-ink-muted',
          className,
        )}
      >
        <span>Could not check whether any events are stuck before routing.</span>
        <Link to={to} className="font-medium text-accent underline-offset-2 hover:underline">
          Open stuck events
        </Link>
      </div>
    );
  }

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
        {state.atLeast ? 'At least ' : ''}
        {state.count} {state.noun} {state.verb} accepted but never routed.
      </span>
      <span className="text-ink-muted">
        {state.pronoun} no deliveries to show here, or only some of them.
      </span>
      <Link to={to} className="font-medium text-accent underline-offset-2 hover:underline">
        Show stuck events
      </Link>
    </div>
  );
}
