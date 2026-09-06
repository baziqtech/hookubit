import { cn } from '../lib/cn';

export interface SkeletonProps {
  className?: string;
}

/**
 * Loading placeholder. Marked `aria-hidden` and paired with a single live
 * region by the caller, so assistive tech hears "loading" once instead of
 * reading out a dozen empty boxes.
 */
export function Skeleton({ className }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'animate-shimmer rounded bg-raised',
        'bg-[linear-gradient(90deg,transparent,rgb(var(--c-line))_50%,transparent)] bg-[length:200%_100%]',
        'h-3.5 w-full',
        className,
      )}
    />
  );
}

/** Table body placeholder that keeps row height stable so nothing jumps on load. */
export function SkeletonRows({ rows = 6, columns = 4 }: { rows?: number; columns?: number }) {
  return (
    <>
      <span className="sr-only" role="status">
        Loading
      </span>
      {Array.from({ length: rows }, (_, row) => (
        <tr key={row} className="border-b border-line last:border-0">
          {Array.from({ length: columns }, (_, column) => (
            <td key={column} className="px-3 py-2.5">
              <Skeleton className={column === 0 ? 'w-24' : column === columns - 1 ? 'w-16' : 'w-40'} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}
