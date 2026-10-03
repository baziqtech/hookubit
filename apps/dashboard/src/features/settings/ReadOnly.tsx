import type { ReactNode } from 'react';

/**
 * A value the API returns and this page cannot change.
 *
 * Kept as a distinct presentation from a form field on purpose: an input the
 * server will refuse is worse than a plain value, because it invites the edit
 * and then loses it.
 */
export function ReadOnly({
  label,
  value,
  mono,
  badge,
}: {
  label: string;
  value: string;
  mono?: boolean;
  badge?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line py-2 last:border-0">
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className={`flex items-center gap-2 text-xs text-ink ${mono ? 'font-mono' : ''}`}>
        {value}
        {badge}
      </dd>
    </div>
  );
}
