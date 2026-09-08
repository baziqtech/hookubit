import { ApiRequestError } from '../lib/api';
import { Button } from './Button';
import { EmptyState } from './EmptyState';

export interface ErrorStateProps {
  error: unknown;
  onRetry?: () => void;
  title?: string;
}

/**
 * The failure surface. Whatever else it shows it always surfaces `request_id`,
 * because that is the string a support conversation actually needs — it is on
 * every log line for the request (docs/API.md, "Errors").
 */
export function ErrorState({ error, onRetry, title }: ErrorStateProps) {
  const details = describe(error);

  return (
    <EmptyState
      tone="error"
      title={title ?? details.title}
      description={
        <span className="flex flex-col items-center gap-2">
          <span>{details.message}</span>
          {REMEDIES[details.code] && (
            <span className="text-ink-muted">{REMEDIES[details.code]}</span>
          )}
          <span className="flex flex-wrap items-center justify-center gap-1.5 font-mono text-2xs text-ink-subtle">
            <span className="rounded border border-line bg-raised px-1.5 py-0.5">
              {details.code}
            </span>
            {details.requestId && (
              <span className="rounded border border-line bg-raised px-1.5 py-0.5">
                request_id: {details.requestId}
              </span>
            )}
          </span>
        </span>
      }
      action={
        onRetry && (
          <Button size="sm" onClick={onRetry}>
            Try again
          </Button>
        )
      }
    />
  );
}

function describe(error: unknown): {
  title: string;
  message: string;
  code: string;
  requestId?: string;
} {
  if (error instanceof ApiRequestError) {
    return {
      title: TITLES[error.body.code] ?? 'Request failed',
      message: error.body.message,
      code: error.body.code,
      requestId: error.body.request_id,
    };
  }
  if (error instanceof Error) {
    return { title: 'Request failed', message: error.message, code: 'network_error' };
  }
  return { title: 'Request failed', message: 'An unexpected error occurred.', code: 'unknown' };
}

const TITLES: Record<string, string> = {
  unauthenticated: 'Your session has expired',
  forbidden: 'You do not have access to this',
  not_found: 'Not found',
  rate_limited: 'Rate limited',
  internal_error: 'Something went wrong on our side',
};

/**
 * The remedy, per code. A failure surface that states only what went wrong
 * leaves the operator to guess the next move; these say it. Roles are granted
 * per organization, so "ask an owner or admin" is always the right advice for a
 * 403 even when this component cannot know which role was required — a page
 * that DOES know should render `PermissionDenied` instead, which names it.
 */
const REMEDIES: Record<string, string> = {
  unauthenticated: 'Sign in again to continue. Nothing was lost.',
  forbidden:
    'Roles are granted per organization. Ask an owner or admin of this organization to change yours on the Team page.',
  not_found:
    'It may have been deleted, or it belongs to a different project — check the project in the breadcrumb above.',
  rate_limited: 'Wait a moment and try again.',
  internal_error: 'This is not something you can fix. Quote the request ID below if you report it.',
};
