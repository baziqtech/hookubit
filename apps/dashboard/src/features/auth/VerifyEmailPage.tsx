import { useEffect, useRef, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { cn } from '../../lib/cn';
import { ApiRequestError } from '../../lib/api';
import { AuthCard, FormError } from './AuthCard';
import { AuthSecondary } from './AuthField';
import { useVerifyEmail } from './api';
import { ResendVerificationForm } from './ResendVerification';

/**
 * The page the verification email lands on: `/verify-email?token=…`, mirroring
 * `/reset-password?token=…`. It posts the token as soon as it has one and
 * renders whatever came back; there is no form, because the link IS the input.
 */
export type VerifyEmailOutcome =
  | { kind: 'missing-token' }
  | { kind: 'verifying' }
  | { kind: 'verified'; email: string }
  | { kind: 'failed'; error: unknown; retry: () => void };

export function VerifyEmailPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const verify = useVerifyEmail();
  const { mutate } = verify;

  /*
   * Exactly one POST per token, and not one per effect run.
   *
   * The token is single-use. Under StrictMode (on, in `main.tsx`) React runs
   * this effect twice on mount, and a second POST would arrive after the first
   * had consumed the token: the server answers `invalid_request`, the page
   * says "expired", and the user has in fact just been verified. The ref
   * survives StrictMode's simulated remount, which a state flag would not.
   */
  const submitted = useRef(false);
  useEffect(() => {
    if (!token || submitted.current) return;
    submitted.current = true;
    mutate({ token });
  }, [token, mutate]);

  const outcome: VerifyEmailOutcome = !token
    ? { kind: 'missing-token' }
    : verify.isSuccess
      ? { kind: 'verified', email: verify.data.user.email }
      : verify.isError
        ? { kind: 'failed', error: verify.error, retry: () => mutate({ token }) }
        : { kind: 'verifying' };

  return <VerifyEmailView outcome={outcome} />;
}

/**
 * The badge above the headline. Decorative: every one of these states says the
 * same thing in the heading text, which is what is announced.
 */
function StatusBadge({ tone, children }: { tone: 'ok' | 'warn' | 'accent'; children: ReactNode }) {
  const TONES = {
    ok: 'bg-ok-soft text-ok',
    warn: 'bg-warn-soft text-warn',
    accent: 'bg-accent-soft text-accent',
  } as const;
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex h-12 w-12 items-center justify-center rounded-2xl',
        TONES[tone],
      )}
    >
      {children}
    </span>
  );
}

function CheckBadge() {
  return (
    <StatusBadge tone="ok">
      <svg viewBox="0 0 24 24" fill="none" className="h-6 w-6">
        <path
          d="m6 12.4 3.9 3.9L18 8"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </StatusBadge>
  );
}

/**
 * A dead link. Drawn as a broken chain rather than a generic warning: the two
 * halves pulling apart say "this link" without a word of copy.
 */
function LinkBadge({ tone }: { tone: 'warn' }) {
  return (
    <StatusBadge tone={tone}>
      <svg viewBox="0 0 24 24" fill="none" className="h-[1.6rem] w-[1.6rem]">
        {/* Two halves of a chain link, pulled apart on the diagonal. */}
        <path
          d="M11 13 8.5 15.5a3.54 3.54 0 0 1-5-5L6 8"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M13 11 15.5 8.5a3.54 3.54 0 0 1 5 5L18 16"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </StatusBadge>
  );
}

/** "Not a real link", not "the server refused it": the same treatment `ResetPasswordPage` gives. */
function MissingToken() {
  return (
    <AuthCard
      icon={<LinkBadge tone="warn" />}
      title="This link is not valid"
      description="The verification link is missing its token. Request a new one."
      footer={
        <Link
          to="/login"
          className="rounded font-medium text-accent underline-offset-4 hover:underline"
        >
          Back to sign in
        </Link>
      }
    >
      <ResendVerificationForm />
    </AuthCard>
  );
}

/**
 * Headline per failure. The envelope's `code` decides, not the sentence:
 * `invalid_request` is the one outcome the service returns for unknown,
 * consumed AND expired tokens (deliberately indistinguishable), a 429 is the
 * per-address throttle, and anything else is the API being unwell.
 */
function failureTitle(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.body.code === 'invalid_request') return 'This link has expired or was already used';
    if (error.body.code === 'rate_limited') return 'Too many attempts';
  }
  return 'We could not verify your email';
}

/**
 * Pure, so every state can be rendered and asserted on. Exported for the test.
 */
export function VerifyEmailView({ outcome }: { outcome: VerifyEmailOutcome }) {
  const titleRef = useRef<HTMLHeadingElement>(null);

  // The card swaps in place — verifying becomes verified or failed with no
  // navigation — so focus moves to the new headline, or nothing is announced.
  useEffect(() => {
    titleRef.current?.focus();
  }, [outcome.kind]);

  switch (outcome.kind) {
    case 'missing-token':
      return <MissingToken />;

    case 'verifying':
      return (
        <AuthCard
          icon={
            <StatusBadge tone="accent">
              <span className="inline-block h-6 w-6 animate-spin rounded-full border-2 border-accent/25 border-t-accent" />
            </StatusBadge>
          }
          title="Verifying your email"
          description="Checking the link. This takes a moment."
          titleRef={titleRef}
        >
          <p role="status" className="flex items-center gap-2 text-sm text-ink-muted">
            <span
              aria-hidden="true"
              className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-line-strong border-t-accent"
            />
            Verifying…
          </p>
        </AuthCard>
      );

    case 'verified':
      return (
        <AuthCard
          icon={<CheckBadge />}
          title="Email verified"
          description={
            <>
              <span className="font-medium text-ink">{outcome.email}</span> is confirmed. Sign in
              to open your organization.
            </>
          }
          titleRef={titleRef}
        >
          {/*
            A link, not a redirect: verifying set no session cookie (the
            controller never touches the response), so there is nowhere to
            forward to except the sign-in form. The address rides along as
            router state so it is already filled in there.
          */}
          <Link
            to="/login"
            state={{ email: outcome.email }}
            data-testid="verified-sign-in"
            className={cn(
              'inline-flex h-11 w-full items-center justify-center rounded-lg border border-transparent',
              'bg-accent px-3 text-sm font-semibold text-accent-ink shadow-panel',
              'transition-colors hover:bg-accent/90',
            )}
          >
            Sign in
          </Link>
        </AuthCard>
      );

    case 'failed': {
      const retryable = outcome.error instanceof ApiRequestError && outcome.error.retryable;
      return (
        <AuthCard
          icon={<LinkBadge tone="warn" />}
          title={failureTitle(outcome.error)}
          description="Verification links are single-use and expire. Enter your email and we will send a fresh one."
          titleRef={titleRef}
          footer={
            <Link
              to="/login"
              className="rounded font-medium text-accent underline-offset-4 hover:underline"
            >
              Back to sign in
            </Link>
          }
        >
          <FormError error={outcome.error} />
          {retryable && (
            <div className="mb-5">
              <AuthSecondary type="button" variant="secondary" onClick={outcome.retry}>
                Try this link again
              </AuthSecondary>
            </div>
          )}
          <ResendVerificationForm />
        </AuthCard>
      );
    }
  }
}
