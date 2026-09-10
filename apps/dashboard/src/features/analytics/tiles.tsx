import type { ReactNode } from 'react';
import { Button, Skeleton } from '../../components';
import { ApiRequestError } from '../../lib/api';

/**
 * The loading and error states of ONE stat tile.
 *
 * The analytics routes are separate requests that land separately, so a tile
 * needs its own placeholder and its own failure surface — `ErrorState` is a
 * full panel, and one of those per failed tile would push the tiles that did
 * load off the screen. These are small enough to sit in a grid cell and still
 * carry the request id.
 */
export function TileSkeleton({ label }: { label: string }) {
  return (
    <div
      className="rounded-lg border border-line bg-panel px-3.5 py-3 shadow-panel"
      aria-busy="true"
    >
      <p className="text-2xs font-medium uppercase tracking-wider text-ink-subtle">{label}</p>
      <Skeleton className="mt-2.5 h-6 w-1/2" />
      <Skeleton className="mt-2 w-3/4" />
    </div>
  );
}

export function TileSkeletons({ labels }: { labels: string[] }) {
  return (
    <>
      <span className="sr-only" role="status">
        Loading
      </span>
      {labels.map((label) => (
        <TileSkeleton key={label} label={label} />
      ))}
    </>
  );
}

/** What a failed request says when there is a grid cell's worth of room. */
export function describeFailure(error: unknown): { message: string; code: string; requestId?: string } {
  if (error instanceof ApiRequestError) {
    return {
      message: error.body.message,
      code: error.body.code,
      requestId: error.body.request_id,
    };
  }
  if (error instanceof Error) return { message: error.message, code: 'network_error' };
  return { message: 'An unexpected error occurred.', code: 'unknown' };
}

export function ErrorTile({
  label,
  error,
  onRetry,
  className,
}: {
  label: string;
  error: unknown;
  onRetry?: () => void;
  className?: string;
}) {
  const failure = describeFailure(error);
  return (
    <div
      role="alert"
      className={`rounded-lg border border-danger/25 bg-danger-soft/40 px-3.5 py-3 shadow-panel ${className ?? ''}`}
    >
      <p className="text-2xs font-medium uppercase tracking-wider text-ink-subtle">{label}</p>
      <p className="mt-1.5 text-xs font-medium text-danger">Could not load</p>
      <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">{failure.message}</p>
      <p className="mt-1 flex flex-wrap gap-1 font-mono text-2xs text-ink-subtle">
        <span className="rounded border border-line bg-raised px-1 py-0.5">{failure.code}</span>
        {failure.requestId && (
          <span className="rounded border border-line bg-raised px-1 py-0.5">
            request_id: {failure.requestId}
          </span>
        )}
      </p>
      {onRetry && (
        <Button size="sm" variant="ghost" className="mt-1.5" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

/** A caption under a section: the exact window the response covered. */
export function WindowCaption({
  window,
  children,
}: {
  window: { from: string; to: string; previous_from: string; previous_to: string; hours: number };
  children?: ReactNode;
}) {
  return (
    <p className="text-2xs leading-relaxed text-ink-subtle">
      Window as the API applied it: <Time iso={window.from} /> to <Time iso={window.to} /> (
      {window.hours}h); compared with <Time iso={window.previous_from} /> to{' '}
      <Time iso={window.previous_to} />. {children}
    </p>
  );
}

function Time({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} className="tabular">
      {iso.replace('T', ' ').replace(/\.\d{3}Z$/, 'Z')}
    </time>
  );
}
