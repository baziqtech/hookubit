import type { UseQueryResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { EmptyState } from './EmptyState';
import { ErrorState } from './ErrorState';
import { Skeleton } from './Skeleton';

export interface AsyncProps<T> {
  query: UseQueryResult<T>;
  children: (data: T) => ReactNode;
  /** Rendered instead of `children` when the query resolves to nothing. */
  empty?: ReactNode;
  isEmpty?: (data: T) => boolean;
  loading?: ReactNode;
}

/**
 * Loading / error / empty, resolved in one place.
 *
 * Every page owes the operator all four states; wiring them per page is how
 * one of them quietly goes missing. Errors go through `ErrorState`, which
 * always surfaces `request_id`.
 */
export function Async<T>({ query, children, empty, isEmpty, loading }: AsyncProps<T>) {
  if (query.isPending) {
    return (
      <>
        <span className="sr-only" role="status">
          Loading
        </span>
        {loading ?? <DefaultLoading />}
      </>
    );
  }

  if (query.isError) {
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }

  const data = query.data as T;
  if (isEmpty?.(data)) {
    return <>{empty ?? <EmptyState title="Nothing here yet" />}</>;
  }

  return <>{children(data)}</>;
}

function DefaultLoading() {
  return (
    <div className="flex flex-col gap-2 py-2">
      <Skeleton className="w-1/3" />
      <Skeleton className="w-2/3" />
      <Skeleton className="w-1/2" />
    </div>
  );
}
