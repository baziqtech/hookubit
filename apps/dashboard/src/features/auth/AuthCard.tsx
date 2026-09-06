import type { ReactNode } from 'react';
import { ApiRequestError } from '../../lib/api';

export function AuthCard({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-line bg-panel p-5 shadow-panel">
      <h1 className="text-sm font-semibold tracking-tight">{title}</h1>
      {description && <p className="mt-1 text-xs text-ink-muted">{description}</p>}
      <div className="mt-5">{children}</div>
      {footer && <div className="mt-5 border-t border-line pt-4 text-xs text-ink-muted">{footer}</div>}
    </div>
  );
}

/**
 * Compact form-level failure. Always prints `request_id` when the server sent
 * one — it is the only handle support has on what actually happened.
 */
export function FormError({ error }: { error: unknown }) {
  if (!error) return null;

  const isApi = error instanceof ApiRequestError;
  const message = isApi
    ? error.body.message
    : error instanceof Error
      ? error.message
      : 'Something went wrong.';
  const requestId = isApi ? error.body.request_id : undefined;

  return (
    <div
      role="alert"
      className="mb-4 rounded-md border border-danger/25 bg-danger-soft px-3 py-2 text-xs text-danger"
    >
      <p>{message}</p>
      {requestId && (
        <p className="mt-1 font-mono text-2xs opacity-80">request_id: {requestId}</p>
      )}
    </div>
  );
}
