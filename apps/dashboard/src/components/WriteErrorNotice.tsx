import { classifyWriteError, writeFailureRemedy, writeFailureTitle } from '../lib/api-errors';
import { cn } from '../lib/cn';

export interface WriteErrorNoticeProps {
  error: unknown;
  className?: string;
}

/**
 * The failure panel for a WRITE, as opposed to `ErrorState`, which is for a
 * read that could not load.
 *
 * It exists to keep two failures visibly different, because their remedies are
 * opposites:
 *
 *   429 `rate_limited`  — transient. Waiting fixes it, and the panel says how
 *                         long. Rendered as a warning.
 *   409 resource ceiling — permanent until something is deleted or an operator
 *                         raises the maximum. Waiting does nothing, so the copy
 *                         must never say "try again". Rendered as an error.
 *
 * Showing one message for both is how a user sits refreshing a form that will
 * never succeed, or deletes a project they needed because a transient 429 read
 * like a quota.
 */
export function WriteErrorNotice({ error, className }: WriteErrorNoticeProps) {
  if (!error) return null;
  const failure = classifyWriteError(error);
  const transient = failure.kind === 'throttled';

  return (
    <div
      role="alert"
      data-testid="write-error"
      data-failure-kind={failure.kind}
      className={cn(
        'flex flex-col gap-1 rounded-md border px-3 py-2 text-xs',
        transient
          ? 'border-warn/40 bg-warn/10 text-warn'
          : 'border-danger/40 bg-danger/10 text-danger',
        className,
      )}
    >
      <span className="font-semibold">{writeFailureTitle(failure)}</span>
      <span className="text-ink-muted">{writeFailureRemedy(failure)}</span>
      {failure.kind !== 'ceiling' && failure.kind !== 'throttled' && null}
      {(failure.kind === 'ceiling' || failure.kind === 'throttled') && (
        <span className="text-2xs text-ink-subtle">{failure.message}</span>
      )}
    </div>
  );
}
