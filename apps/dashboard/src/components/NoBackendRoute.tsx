import { EmptyState } from './EmptyState';

/**
 * A screen the mock serves and the control API does not.
 *
 * This is a different thing from `Placeholder`, which marks a route nobody has
 * built a UI for. These screens ARE built, and they work — against fabricated
 * data. There is no route behind them in the published OpenAPI document, so
 * against the real transport they 404.
 *
 * Rendering the 404 as a red "request failed" would be wrong twice over: it
 * reads as an outage, and it invites a retry that cannot succeed. So the page
 * says the specific thing that is true — this feature has no backend, here is
 * the route it needs — and does not run the query at all.
 *
 * `path` is deliberately shown. The next person's question is "what would the
 * API have to add?", and the answer is one line.
 */
export function NoBackendRoute({ title, path, purpose }: {
  title: string;
  path: string;
  purpose: string;
}) {
  return (
    <EmptyState
      tone="error"
      title={`${title} has no control-API route`}
      description={
        <span className="flex flex-col items-center gap-2">
          <span>
            This screen is built and works against the demo data, but{' '}
            <code className="rounded border border-line bg-raised px-1 py-0.5 font-mono text-2xs">
              {path}
            </code>{' '}
            is not in the control API’s OpenAPI document — there is no module behind it, so nothing
            here can be shown against real data.
          </span>
          <span className="text-ink-subtle">{purpose}</span>
        </span>
      }
    />
  );
}
