import { classifyWriteError, writeFailureRemedy, writeFailureTitle } from '../lib/api-errors';
import { cn } from '../lib/cn';

export interface WriteErrorNoticeProps {
  error: unknown;
  /**
   * Fields the caller has already placed under their own input.
   *
   * A form that calls `setError('url', …)` shows that reason where the user is
   * looking; repeating it in the panel above reads as two separate problems.
   * Anything the form could NOT place still appears here, so a rejection is
   * never silently dropped.
   */
  claimedFields?: readonly string[];
  className?: string;
}

/**
 * The failure panel for a WRITE, as opposed to `ErrorState`, which is for a
 * read that could not load.
 *
 * It exists to keep three failures visibly different, because their remedies
 * are not the same:
 *
 *   429 `rate_limited`   — transient. Waiting fixes it, and the panel says how
 *                          long. Rendered as a warning.
 *   409 `limit_exceeded` — permanent until something is deleted or an operator
 *                          raises the maximum. Waiting does nothing, so the
 *                          copy must never say "try again".
 *   400 `invalid_request`— one or more named fields were refused. The reasons
 *                          are listed, because "Check the details" alone tells
 *                          an operator nothing about WHICH detail.
 *
 * Showing one message for all of them is how a user sits refreshing a form that
 * will never succeed, or deletes a project they needed because a transient 429
 * read like a quota.
 */
export function WriteErrorNotice({ error, claimedFields, className }: WriteErrorNoticeProps) {
  if (!error) return null;
  const failure = classifyWriteError(error);
  const transient = failure.kind === 'throttled';

  // Only the rejections the form could not attach to an input.
  const unclaimed =
    failure.kind === 'invalid'
      ? failure.issues.filter(
          (issue) => issue.field === null || !claimedFields?.includes(issue.field),
        )
      : [];

  // Every issue was placed under its own input; a second copy up here would
  // read as a second problem.
  if (failure.kind === 'invalid' && failure.issues.length > 0 && unclaimed.length === 0) {
    return null;
  }

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
      {failure.kind === 'invalid' ? (
        <ul className="flex flex-col gap-0.5 text-ink-muted">
          {unclaimed.map((issue) => (
            <li key={issue.message}>
              {issue.field && <span className="font-mono text-2xs text-ink">{issue.field}</span>}{' '}
              {issue.reason}
            </li>
          ))}
        </ul>
      ) : (
        <span className="text-ink-muted">{writeFailureRemedy(failure)}</span>
      )}
      {(failure.kind === 'ceiling' || failure.kind === 'throttled') && (
        <span className="text-2xs text-ink-subtle">{failure.message}</span>
      )}
    </div>
  );
}
