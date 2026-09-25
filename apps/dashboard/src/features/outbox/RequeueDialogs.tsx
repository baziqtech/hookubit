import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  Badge,
  Button,
  Dialog,
  Input,
  PermissionDenied,
  WriteErrorNotice,
} from '../../components';
import { ApiRequestError } from '../../lib/api';
import { cn } from '../../lib/cn';
import { truncateId } from '../../lib/format';
import {
  MAX_REQUEUE_BATCH,
  MAX_REQUEUE_REASON_LENGTH,
  type OutboxEntry,
  type Role,
} from '../../types/api';
import { useOutboxEntries, useRequeueOutboxEntry, useRequeueParked } from './api';
import { explainParked, futileSummary, isParked } from './parked';
import { ParkedExplanation } from './ParkedExplanation';
import { mayRequeue, requeueDeniedReason, REQUEUE_ROLES, type RequeueGate } from './permissions';
import {
  canContinue,
  completePass,
  describeRun,
  failPass,
  idleRun,
  passButtonLabel,
  startPass,
  totalRequeued,
  type RequeueRun,
} from './requeue-loop';

/**
 * The reason is REQUIRED here and optional on the wire, deliberately.
 *
 * `RequeueOutboxDto.reason` goes to the audit log and nowhere else. The server
 * accepts an empty one because an API client in a runbook should not be
 * refused for a missing sentence; a person at 2am pressing a button that
 * causes real outbound HTTP to customers should have to say why, because that
 * sentence is what makes the audit row readable next week.
 */
function useReason() {
  const [reason, setReason] = useState('');
  const trimmed = reason.trim();
  const error =
    reason.length > MAX_REQUEUE_REASON_LENGTH
      ? `At most ${MAX_REQUEUE_REASON_LENGTH} characters.`
      : undefined;
  return { reason, setReason, trimmed, valid: trimmed.length > 0 && !error, error };
}

function isForbidden(error: unknown): error is ApiRequestError {
  return (
    error instanceof ApiRequestError &&
    (error.status === 403 || error.body.code === 'forbidden')
  );
}

/** The gate, as a disabled-with-a-reason button rather than a missing one. */
export function RequeueButton({
  gate,
  onClick,
  size = 'sm',
  children,
  variant,
  className,
}: {
  gate: RequeueGate;
  onClick: () => void;
  size?: 'sm' | 'md';
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'danger';
  className?: string;
}) {
  const allowed = mayRequeue(gate);
  return (
    <Button
      size={size}
      variant={variant}
      onClick={onClick}
      disabled={!allowed}
      title={requeueDeniedReason(gate)}
      aria-disabled={!allowed || undefined}
      data-testid="requeue-button"
      className={className}
    >
      {children}
    </Button>
  );
}

/**
 * Requeue ONE parked row. Reason required, and the dialog says what a requeue
 * is — and is not — before the button, because "requeue" reads like "replay"
 * and the two have different semantics on the same event.
 */
export function RequeueEntryDialog({
  entry,
  projectId,
  currentRole,
  onClose,
}: {
  entry: OutboxEntry;
  projectId: string;
  currentRole?: Role;
  onClose: () => void;
}) {
  const requeue = useRequeueOutboxEntry(projectId);
  const reason = useReason();
  const explanation = explainParked(entry);
  const parked = isParked(entry);

  if (isForbidden(requeue.error)) {
    return (
      <Dialog open onClose={onClose} title="Requeue this event?" footer={<Button onClick={onClose}>Close</Button>}>
        <PermissionDenied
          action="requeue a parked event"
          requiredRoles={[...REQUEUE_ROLES]}
          currentRole={currentRole}
          error={requeue.error}
        />
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Requeue this event?"
      description={
        <span className="font-mono">
          {truncateId(entry.event_id)} · outbox {truncateId(entry.id)}
        </span>
      }
      footer={
        <>
          <Button onClick={onClose}>{requeue.isSuccess ? 'Close' : 'Cancel'}</Button>
          {!requeue.isSuccess && (
            <Button
              variant={explanation.outlook === 'safe' ? 'primary' : 'danger'}
              loading={requeue.isPending}
              disabled={!reason.valid || !parked}
              onClick={() => requeue.mutate({ outboxId: entry.id, reason: reason.trimmed })}
            >
              {explanation.outlook === 'safe' ? 'Requeue' : 'Requeue anyway'}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <ParkedExplanation entry={entry} />

        {!parked && (
          <p className="rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-warn">
            This row is not parked any more, so the API will refuse to requeue it.
          </p>
        )}

        <RequeueSemantics partial={explanation.partial} />

        <Input
          label="Reason"
          required
          hint="Recorded on the audit entry, not on the row. Say what was wrong and why it is safe now."
          placeholder="e.g. Postgres failover 02:10–03:20 resolved; requeueing what it parked"
          value={reason.reason}
          error={reason.error}
          maxLength={MAX_REQUEUE_REASON_LENGTH + 1}
          onChange={(event) => reason.setReason(event.target.value)}
          disabled={requeue.isSuccess}
        />

        {requeue.isSuccess && (
          <p
            role="status"
            className="rounded-md border border-ok/30 bg-ok-soft/60 px-3 py-2 text-xs text-ink"
          >
            Back in the queue. The event is <strong>received</strong> again and the router will pick
            it up shortly; the delivery rows appear on the event page as the routing writes them.
          </p>
        )}
        <WriteErrorNotice error={requeue.error} />
      </div>
    </Dialog>
  );
}

/**
 * The sentences that stop "requeue" being read as "replay". Shared by both
 * dialogs so they cannot drift.
 */
function RequeueSemantics({ partial }: { partial: boolean }) {
  return (
    <ul className="flex flex-col gap-1 rounded-md border border-line bg-raised px-3 py-2 text-2xs leading-relaxed text-ink-muted">
      <li>
        <strong className="text-ink">Not a replay.</strong> A parked event has no delivery rows to
        replay; requeueing lets the router run the routing it never got to run.
      </li>
      <li>
        Only subscriptions that existed when the event was <em>accepted</em> receive it, using
        their configuration as of now. One deleted since is gone.
      </li>
      <li>
        {partial
          ? 'The routing resumes from its cursor — endpoints already reached are not sent a second copy.'
          : 'The claim count and the last error are preserved, so the history survives the recovery.'}
      </li>
    </ul>
  );
}

/**
 * Requeue EVERY parked row in scope, `MAX_REQUEUE_BATCH` at a time, with the
 * `has_more` loop on screen.
 *
 * `scopeEventId` narrows it to one event when the page is filtered to one —
 * the API refuses nothing for an event with no parked rows, it just requeues
 * zero and audits that, so the dialog says so rather than looking broken.
 */
export function BulkRequeueDialog({
  projectId,
  scopeEventId,
  currentRole,
  onClose,
}: {
  projectId: string;
  scopeEventId?: string;
  currentRole?: Role;
  onClose: () => void;
}) {
  const requeue = useRequeueParked(projectId);
  const reason = useReason();
  const [run, setRun] = useState<RequeueRun>(idleRun);

  const sendPass = async () => {
    setRun((current) => startPass(current));
    try {
      const result = await requeue.mutateAsync({
        reason: reason.trimmed,
        ...(scopeEventId ? { event_id: scopeEventId } : {}),
      });
      setRun((current) => completePass(current, result));
    } catch (error) {
      setRun((current) => failPass(current, error));
    }
  };

  if (isForbidden(run.error)) {
    return (
      <Dialog open onClose={onClose} title="Requeue parked events" footer={<Button onClick={onClose}>Close</Button>}>
        <PermissionDenied
          action="requeue parked events"
          requiredRoles={[...REQUEUE_ROLES]}
          currentRole={currentRole}
          error={run.error}
        />
      </Dialog>
    );
  }

  const busy = run.status === 'running';

  return (
    <Dialog
      open
      onClose={busy ? () => undefined : onClose}
      title={scopeEventId ? 'Requeue this event’s parked rows' : 'Requeue every parked event'}
      description={
        scopeEventId ? (
          <span className="font-mono">{scopeEventId}</span>
        ) : (
          'Oldest first, in bounded passes.'
        )
      }
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            {run.status === 'drained' ? 'Close' : 'Cancel'}
          </Button>
          {run.status !== 'drained' && (
            <Button
              variant="primary"
              loading={busy}
              disabled={!reason.valid || !canContinue(run)}
              onClick={() => void sendPass()}
              data-testid="bulk-pass-button"
            >
              {passButtonLabel(run)}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <RequeueSemantics partial={false} />

        <FutileWarning projectId={projectId} scopeEventId={scopeEventId} />

        <p className="text-2xs leading-relaxed text-ink-muted">
          Each pass returns at most {MAX_REQUEUE_BATCH} rows and every one becomes real outbound
          HTTP — usually to endpoints that were already struggling when the incident started —
          so the passes are yours to send, not automatic. The API allows ten passes per five
          minutes.
        </p>

        <Input
          label="Reason"
          required
          hint="Recorded once per pass on the audit log."
          placeholder="e.g. Incident 4471 — database failover resolved"
          value={reason.reason}
          error={reason.error}
          maxLength={MAX_REQUEUE_REASON_LENGTH + 1}
          onChange={(event) => reason.setReason(event.target.value)}
          disabled={run.passes.length > 0}
        />

        <RunTally run={run} />

        {!isForbidden(run.error) && <WriteErrorNotice error={run.error} />}
      </div>
    </Dialog>
  );
}

/** The passes so far, and — always — whether there is more. */
export function RunTally({ run }: { run: RequeueRun }) {
  const tone = {
    idle: 'border-line bg-raised/50',
    running: 'border-info/30 bg-info-soft/50',
    more: 'border-warn/40 bg-warn-soft/60',
    drained: 'border-ok/30 bg-ok-soft/60',
    failed: 'border-danger/40 bg-danger-soft/60',
  }[run.status];

  return (
    <section
      aria-live="polite"
      data-testid="requeue-run"
      data-run-status={run.status}
      className={cn('rounded-md border px-3 py-2', tone)}
    >
      <p className="text-xs leading-relaxed text-ink">{describeRun(run)}</p>
      {run.passes.length > 0 && (
        <ol className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {run.passes.map((pass, index) => (
            <li key={index} className="flex items-center gap-1">
              <Badge tone={pass.has_more ? 'warn' : 'ok'}>
                pass {index + 1}: {pass.requeued}
                {pass.has_more ? ' · more remain' : ' · drained'}
              </Badge>
            </li>
          ))}
          <li className="text-2xs text-ink-subtle">{totalRequeued(run)} total</li>
        </ol>
      )}
    </section>
  );
}

/** The link back to the event, phrased for the row. */
export function EventLink({
  orgId,
  projectId,
  eventId,
}: {
  orgId: string;
  projectId: string;
  eventId: string;
}) {
  return (
    <Link
      to={`/orgs/${orgId}/projects/${projectId}/events/${eventId}`}
      className="font-mono text-xs text-accent hover:underline"
    >
      {truncateId(eventId)}
    </Link>
  );
}

/**
 * "N of these will park again for the same reason."
 *
 * Read from the parked list the page already has in cache, so this costs no
 * request. It renders nothing when there is nothing to say — the common case
 * has to be free, or the warning becomes furniture that gets read past on the
 * one day it matters.
 *
 * It does NOT disable the button. Requeueing a futile row is harmless and
 * occasionally correct: somebody who has just deployed a router that handles
 * that kind of row knows something this classification does not. The warning
 * is there so that is a decision rather than a surprise.
 */
function FutileWarning({
  projectId,
  scopeEventId,
}: {
  projectId: string;
  scopeEventId?: string;
}) {
  const parked = useOutboxEntries(projectId, { status: 'failed' }, 0);
  const rows = (parked.data?.rows ?? []).filter(
    (row) => !scopeEventId || row.event_id === scopeEventId,
  );
  const summary = futileSummary(rows);
  if (!summary) return null;

  return (
    <div className="flex flex-col gap-1.5 rounded-[0.625rem] border border-warn/30 bg-warn-soft px-3 py-2.5">
      <p className="text-xs font-semibold text-warn">
        {summary.count} of {summary.total} will park again
      </p>
      <p className="text-2xs leading-relaxed text-ink-muted">
        {summary.count === 1 ? 'One row is' : `${summary.count} rows are`} parked for a reason
        putting them back cannot change — no router handles that kind of row, or the event they
        point at is gone. They will be claimed, fail identically, and park again. Nothing changes
        for them until a router that understands them is deployed.
      </p>
    </div>
  );
}
