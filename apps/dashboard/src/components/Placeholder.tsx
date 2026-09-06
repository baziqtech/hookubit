import { EmptyState } from './EmptyState';

/**
 * Honest stub for a route whose feature has not been built. It exists so the
 * route tree is complete and navigable now — nothing has to be re-parented
 * when the page lands — without pretending the feature works.
 */
export function Placeholder({ title, planned }: { title: string; planned: string[] }) {
  return (
    <EmptyState
      title={`${title} is not built yet`}
      description={
        <>
          <p className="mb-2">This route is reserved and wired into navigation. It will carry:</p>
          <ul className="mx-auto inline-flex list-disc flex-col gap-0.5 pl-4 text-left">
            {planned.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </>
      }
    />
  );
}
