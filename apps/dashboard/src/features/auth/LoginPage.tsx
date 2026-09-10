import type { ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ApiRequestError } from '../../lib/api';
import type { LoginBody } from '../../types/api';
import { AuthCard, FormError } from './AuthCard';
import { AuthInput, AuthPasswordInput, AuthSubmit, MailGlyph } from './AuthField';
import { useLogin } from './api';
import { ResendVerificationForm } from './ResendVerification';

/**
 * Login-specific failure rendering.
 *
 * `email_not_verified` (403) is not a credential problem — the password was
 * right — so the generic "that didn't work" panel sends the user round the
 * reset-password loop for an account that is fine. It gets the same wording as
 * the confirmation `RegisterPage` already ends on, so a user who registered,
 * missed the email and came here reads one consistent story.
 *
 * `action` is the way out — the resend control — passed in rather than
 * rendered here so this stays a pure function of the error: it needs no query
 * client, and the test can render it bare.
 *
 * Exported for the test, and because this is the piece worth asserting on.
 */
export function LoginError({ error, action }: { error: unknown; action?: ReactNode }) {
  const unverified = error instanceof ApiRequestError && error.body.code === 'email_not_verified';
  if (!unverified) return <FormError error={error} />;

  return (
    <div
      role="alert"
      data-testid="login-email-not-verified"
      className="mb-5 rounded-xl border border-warn/25 bg-warn-soft px-3.5 py-3 text-sm text-warn"
    >
      <div className="flex gap-2.5">
        <MailGlyph className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0">
          <p className="font-medium">Check your email to verify this address</p>
          <p className="mt-1 leading-relaxed">
            We sent a verification link when the account was created. Follow it to confirm your
            email, then sign in. Check spam if it has not arrived.
          </p>
          {action && <div className="mt-3">{action}</div>}
        </div>
      </div>
      {error.body.request_id && (
        <p className="mt-2 break-all border-t border-warn/20 pt-2 font-mono text-2xs opacity-80">
          request_id: {error.body.request_id}
        </p>
      )}
    </div>
  );
}

/**
 * `/verify-email` sends a just-verified user here with their address as router
 * state, so they do not retype what the link already proved. Anything else in
 * state (a `from` path, nothing at all) leaves the field empty.
 */
function emailFromState(state: unknown): string {
  if (typeof state !== 'object' || state === null) return '';
  const { email } = state as { email?: unknown };
  return typeof email === 'string' ? email : '';
}

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { from } = (location.state ?? {}) as { from?: unknown };
  const login = useLogin();
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginBody>({
    defaultValues: { email: emailFromState(location.state), password: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    await login.mutateAsync(values);
    /*
     * `/orgs`, NOT `/orgs/<first org>`.
     *
     * `SessionResponseDto` is `{ user }` and nothing else — it does NOT carry
     * an organization list, though this line read `session.organizations[0]`
     * until the generated types said otherwise. Landing on `/orgs` lets
     * `RootRedirect` fetch the list from the route that actually serves it and
     * forward from there, which is one extra request on a page transition the
     * user is already waiting through.
     */
    // …unless a gate sent them here with `state.from` (`RequireSession`, or the
    // accept-invitation page keeping its token): an in-app path only.
    const inApp = typeof from === 'string' && from.startsWith('/') && !from.startsWith('//');
    navigate(inApp ? from : '/orgs', { replace: true });
  });

  return (
    <AuthCard
      title="Sign in"
      description="Use your organization account to open the delivery log."
      footer={
        <span>
          No account?{' '}
          <Link
            to="/register"
            className="rounded font-medium text-accent underline-offset-4 hover:underline"
          >
            Create one
          </Link>
        </span>
      }
    >
      <LoginError
        error={login.error}
        // The address they just signed in with — `variables` is the body of
        // the attempt that failed, not whatever is in the input now.
        action={
          login.variables?.email ? (
            <ResendVerificationForm email={login.variables.email} locked />
          ) : undefined
        }
      />
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <AuthInput
          label="Email"
          type="email"
          autoComplete="email"
          autoFocus
          required
          placeholder="you@company.com"
          error={errors.email?.message}
          {...register('email', {
            required: 'Email is required',
            pattern: { value: /.+@.+\..+/, message: 'Enter a valid email address' },
          })}
        />
        <AuthPasswordInput
          label="Password"
          autoComplete="current-password"
          required
          error={errors.password?.message}
          // On the label row, not below the field: the moment you need it is
          // while you are looking at the label, and it keeps the submit button
          // the only thing under the form.
          action={
            <Link
              to="/forgot-password"
              className="rounded text-xs font-medium text-ink-subtle underline-offset-4 transition-colors hover:text-accent hover:underline"
            >
              Forgot password?
            </Link>
          }
          {...register('password', { required: 'Password is required' })}
        />
        <AuthSubmit loading={login.isPending}>Sign in</AuthSubmit>
      </form>
    </AuthCard>
  );
}
