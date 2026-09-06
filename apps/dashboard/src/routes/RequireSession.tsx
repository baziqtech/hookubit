import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { ApiRequestError } from '../lib/api';
import { ErrorState, Skeleton } from '../components';
import { useSession } from '../features/auth/api';

/**
 * Session gate. There is no token to inspect — the session is an HTTP-only
 * cookie — so the check is a request, and "am I signed in?" is answered by the
 * server or not at all (ARCHITECTURE.md 9).
 */
export function RequireSession() {
  const session = useSession();
  const location = useLocation();

  if (session.isPending) return <BootSkeleton />;

  if (session.isError) {
    const unauthenticated =
      session.error instanceof ApiRequestError && session.error.status === 401;

    if (unauthenticated) {
      // Preserve where they were headed so sign-in can return them to it.
      return <Navigate to="/login" replace state={{ from: location.pathname }} />;
    }
    return (
      <div className="p-10">
        <ErrorState error={session.error} onRetry={() => void session.refetch()} />
      </div>
    );
  }

  return <Outlet />;
}

function BootSkeleton() {
  return (
    <div className="flex min-h-screen">
      <div className="w-60 shrink-0 border-r border-line bg-panel p-3">
        <span className="sr-only" role="status">
          Loading session
        </span>
        <Skeleton className="mb-4 h-5 w-28" />
        <Skeleton className="mb-2 h-7" />
        <Skeleton className="mb-6 h-7" />
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="mb-1.5 h-5" />
        ))}
      </div>
      <div className="flex-1 p-6">
        <Skeleton className="mb-4 h-6 w-40" />
        <Skeleton className="h-40" />
      </div>
    </div>
  );
}
