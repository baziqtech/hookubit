import { useEffect, useRef } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '../../components';
import { ApiRequestError } from '../../lib/api';
import type { Organization, Role } from '../../types/api';
import { AuthCard, FormError } from '../auth/AuthCard';
import { useLogout, useSession } from '../auth/api';
import { useAcceptInvitation } from './api';

/**
 * The page the invitation email lands on: `/accept-invitation?token=…`, the
 * shape `/verify-email` and `/reset-password` use. Unlike those two it needs a
 * SESSION — the token proves a mailbox, the session proves who is asking, and
 * `MembersService.accept` refuses unless they are the same address — so the
 * page first asks who is signed in, and only then posts.
 *
 * Every state is a function of `outcome`, rendered by the pure view below.
 */
export type AcceptInvitationOutcome =
  | { kind: 'missing-token' }
  | { kind: 'checking-session' }
  | { kind: 'session-unavailable'; error: unknown; retry: () => void }
  /** No session. `returnTo` is this page WITH its token, for sign-in to come back to. */
  | { kind: 'signed-out'; returnTo: string }
  | {
      kind: 'confirm';
      email: string;
      accept: () => void;
      signOut: () => void;
      signingOut: boolean;
    }
  | { kind: 'accepting'; email: string }
  | { kind: 'accepted'; organization: Organization }
  | {
      kind: 'failed';
      error: unknown;
      /** The address the attempt was made as — the one the token was checked against. */
      email: string;
      retry: () => void;
      signOut: () => void;
      signingOut: boolean;
    };

/**
 * The path sign-in returns to, token included. It rides along as router state
 * (`state.from`, the field `RequireSession` already sets and `LoginPage` reads)
 * rather than in the login URL, so the token is not written into a second
 * page's history. State does not survive a reload of the sign-in form, but the
 * emailed link is the durable copy and stays valid until it is redeemed.
 */
export function returnPathFor(location: { pathname: string; search: string }): string {
  return `${location.pathname}${location.search}`;
}

function isUnauthenticated(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 401;
}

export function AcceptInvitationPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const location = useLocation();
  const navigate = useNavigate();
  const session = useSession();
  const accept = useAcceptInvitation();
  const logout = useLogout();
  const { mutate } = accept;

  /*
   * Nothing is POSTed on mount. The server consumes the token BEFORE it checks
   * whose session is presenting it, so a wrong-account click would burn the
   * invitation with no way back - the failed card can only say "ask for a new
   * one". Redeeming is therefore an explicit action on a card that names the
   * account it will be redeemed for, with sign-out offered first. Until the
   * button is pressed the token is untouched, so a sign-out detour returns to
   * this page with a still-valid link.
   */
  const email = session.data?.user.email;
  const acceptNow = () => {
    if (!token || !email || accept.isPending || accept.isSuccess) return;
    mutate({ token });
  };

  const returnTo = returnPathFor(location);

  let outcome: AcceptInvitationOutcome;
  if (!token) {
    outcome = { kind: 'missing-token' };
  } else if (session.isPending) {
    outcome = { kind: 'checking-session' };
  } else if (session.isError) {
    outcome = isUnauthenticated(session.error)
      ? { kind: 'signed-out', returnTo }
      : { kind: 'session-unavailable', error: session.error, retry: () => void session.refetch() };
  } else if (accept.isSuccess) {
    outcome = { kind: 'accepted', organization: accept.data.organization };
  } else if (accept.isError) {
    // The session lapsed between the check and the POST: same answer as no session.
    outcome = isUnauthenticated(accept.error)
      ? { kind: 'signed-out', returnTo }
      : {
          kind: 'failed',
          error: accept.error,
          email: session.data.user.email,
          retry: () => mutate({ token }),
          // The token is already spent, so there is nothing to return to: plain sign-in.
          signOut: () =>
            logout.mutate(undefined, { onSuccess: () => navigate('/login', { replace: true }) }),
          signingOut: logout.isPending,
        };
  } else if (accept.isPending) {
    outcome = { kind: 'accepting', email: session.data.user.email };
  } else {
    outcome = {
      kind: 'confirm',
      email: session.data.user.email,
      accept: acceptNow,
      // Nothing has been redeemed, so the link is still good: come back to it
      // as the right account.
      signOut: () =>
        logout.mutate(undefined, {
          onSuccess: () => navigate('/login', { replace: true, state: { from: returnTo } }),
        }),
      signingOut: logout.isPending,
    };
  }

  return <AcceptInvitationView outcome={outcome} />;
}

/** Display names for the closed `Role` union; adding a role is a compile error here. */
const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Admin',
  developer: 'Developer',
  viewer: 'Viewer',
  billing: 'Billing',
};

const PRIMARY_LINK =
  'inline-flex h-8 w-full items-center justify-center rounded-md border border-transparent bg-accent px-3 text-sm font-medium text-accent-ink transition-colors hover:bg-accent/90';

function Spinner({ children }: { children: string }) {
  return (
    <p role="status" className="flex items-center gap-2 text-xs text-ink-muted">
      <span
        aria-hidden="true"
        className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-line-strong border-t-accent"
      />
      {children}
    </p>
  );
}

/** "Not a real link", not "the server refused it": the treatment the reset and verify pages give. */
function MissingToken() {
  return (
    <AuthCard
      title="This link is not valid"
      description="The invitation link is missing its token. Ask the person who invited you to send it again."
      footer={
        <Link to="/login" className="font-medium text-accent hover:underline">
          Back to sign in
        </Link>
      }
    >
      <p className="text-xs text-ink-muted">
        Invitations expire 7 days after they are sent and can be used once. Open the most recent
        link from your email in full.
      </p>
    </AuthCard>
  );
}

/**
 * Headline per failure. The envelope's `code` decides, not the sentence.
 * `invalid_request` is the ONE outcome the service returns for an unknown,
 * consumed, expired, or wrong-address token — deliberately indistinguishable —
 * `conflict` is the organization or the inviter no longer supporting it, a
 * 429 is the throttle, and anything else is the API being unwell.
 */
function failureTitle(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.body.code === 'invalid_request') return 'This invitation cannot be used';
    if (error.body.code === 'conflict') return 'This invitation cannot be completed';
    if (error.body.code === 'rate_limited') return 'Too many attempts';
  }
  return 'We could not accept this invitation';
}

/**
 * Pure, so every state can be rendered and asserted on. Exported for the test.
 */
export function AcceptInvitationView({ outcome }: { outcome: AcceptInvitationOutcome }) {
  const titleRef = useRef<HTMLHeadingElement>(null);

  // The card swaps in place — checking becomes accepting becomes accepted or
  // failed with no navigation — so focus moves to the new headline, or
  // nothing is announced.
  useEffect(() => {
    titleRef.current?.focus();
  }, [outcome.kind]);

  switch (outcome.kind) {
    case 'missing-token':
      return <MissingToken />;

    case 'checking-session':
      return (
        <AuthCard
          title="Opening your invitation"
          description="Checking whether you are signed in. This takes a moment."
          titleRef={titleRef}
        >
          <Spinner>Checking your session…</Spinner>
        </AuthCard>
      );

    case 'session-unavailable':
      return (
        <AuthCard
          title="We could not check your session"
          description="Nothing has been done with the invitation yet, so it is safe to try again."
          titleRef={titleRef}
        >
          <FormError error={outcome.error} />
          <Button type="button" variant="secondary" size="sm" onClick={outcome.retry}>
            Try again
          </Button>
        </AuthCard>
      );

    case 'signed-out':
      return (
        <AuthCard
          title="Sign in to accept this invitation"
          description="An invitation is tied to the address it was sent to. Sign in with that address and it is accepted for you as soon as you are back here."
          titleRef={titleRef}
        >
          {/*
            The token travels as `state.from` — the same field `RequireSession`
            sets — so `LoginPage` brings them straight back to this URL.
          */}
          <Link
            to="/login"
            state={{ from: outcome.returnTo }}
            data-testid="signed-out-sign-in"
            className={PRIMARY_LINK}
          >
            Sign in
          </Link>
          <p className="mt-4 text-xs text-ink-muted">
            No account yet?{' '}
            <Link
              to="/register"
              data-testid="signed-out-register"
              className="font-medium text-accent hover:underline"
            >
              Create one
            </Link>{' '}
            with the invited address, confirm your email, then open this invitation link again.
            It stays valid until it is used or expires.
          </p>
        </AuthCard>
      );

    case 'confirm':
      return (
        <AuthCard
          title="Accept this invitation?"
          description={
            <>
              It will be redeemed for{' '}
              <span className="font-medium text-ink">{outcome.email}</span>, the account you are
              signed in as. An invitation can be used once: if it was sent to a different address,
              sign out first - accepting from the wrong account uses it up.
            </>
          }
          titleRef={titleRef}
        >
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={outcome.accept}
              data-testid="confirm-accept"
              className={PRIMARY_LINK}
            >
              Accept as {outcome.email}
            </button>
            <button
              type="button"
              onClick={outcome.signOut}
              disabled={outcome.signingOut}
              data-testid="confirm-sign-out"
              className="text-sm text-ink-subtle underline-offset-2 hover:underline disabled:opacity-60"
            >
              {outcome.signingOut ? 'Signing out…' : 'Not you? Sign out and come back to this link'}
            </button>
          </div>
        </AuthCard>
      );

    case 'accepting':
      return (
        <AuthCard
          title="Accepting your invitation"
          description={
            <>
              Joining as <span className="font-medium text-ink">{outcome.email}</span>.
            </>
          }
          titleRef={titleRef}
        >
          <Spinner>Accepting…</Spinner>
        </AuthCard>
      );

    case 'accepted': {
      const { organization } = outcome;
      return (
        <AuthCard
          // "A member of", not "joined": redeeming an invitation to an
          // organization you already belong to returns it unchanged, and the
          // response cannot tell the two apart.
          title={`You are a member of ${organization.name}`}
          description={
            <span role="status" data-testid="accepted-role">
              Your role in {organization.name} is{' '}
              <span className="font-medium text-ink">{ROLE_LABELS[organization.role]}</span>.
            </span>
          }
          titleRef={titleRef}
        >
          <Link
            to={`/orgs/${organization.id}`}
            data-testid="accepted-open"
            className={PRIMARY_LINK}
          >
            Open {organization.name}
          </Link>
        </AuthCard>
      );
    }

    case 'failed': {
      const code = outcome.error instanceof ApiRequestError ? outcome.error.body.code : undefined;
      const retryable = outcome.error instanceof ApiRequestError && outcome.error.retryable;
      return (
        <AuthCard
          title={failureTitle(outcome.error)}
          description={
            code === 'invalid_request'
              ? 'Invitations are single-use and expire after 7 days.'
              : code === 'conflict'
                ? 'The organization or the member who invited you can no longer support it.'
                : 'Nothing was changed on your account.'
          }
          titleRef={titleRef}
          footer={
            <Link to="/orgs" className="font-medium text-accent hover:underline">
              Go to your organizations
            </Link>
          }
        >
          <FormError error={outcome.error} />
          {code === 'invalid_request' && (
            <div className="flex flex-col gap-3 text-xs text-ink-muted">
              <p>
                This link may have expired, already been used, or been sent to a different
                address from the one you are signed in as (
                <span className="font-medium text-ink">{outcome.email}</span>). Either way it
                cannot be used again: ask the person who invited you to send a new invitation.
              </p>
              <p>
                If it was meant for another address, sign out first and open the new link while
                signed in as that address.
              </p>
              <div>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={outcome.signOut}
                  loading={outcome.signingOut}
                >
                  Sign out
                </Button>
              </div>
            </div>
          )}
          {code === 'conflict' && (
            <p className="text-xs text-ink-muted">
              This attempt used the invitation up, so a new one is needed even once that is
              resolved.
            </p>
          )}
          {retryable && (
            <div className="flex flex-col gap-3 text-xs text-ink-muted">
              <p>The invitation may still be valid.</p>
              <div>
                <Button type="button" variant="secondary" size="sm" onClick={outcome.retry}>
                  Try again
                </Button>
              </div>
            </div>
          )}
        </AuthCard>
      );
    }
  }
}
