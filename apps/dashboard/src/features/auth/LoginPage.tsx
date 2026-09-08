import { useForm } from 'react-hook-form';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Input } from '../../components';
import { ApiRequestError } from '../../lib/api';
import type { LoginBody } from '../../types/api';
import { AuthCard, FormError } from './AuthCard';
import { useLogin } from './api';

/**
 * Login-specific failure rendering.
 *
 * `email_not_verified` (403) is not a credential problem — the password was
 * right — so the generic "that didn't work" panel sends the user round the
 * reset-password loop for an account that is fine. It gets the same wording as
 * the confirmation `RegisterPage` already ends on, so a user who registered,
 * missed the email and came here reads one consistent story.
 *
 * Exported for the test, and because this is the piece worth asserting on.
 */
export function LoginError({ error }: { error: unknown }) {
  const unverified = error instanceof ApiRequestError && error.body.code === 'email_not_verified';
  if (!unverified) return <FormError error={error} />;

  return (
    <div
      role="alert"
      data-testid="login-email-not-verified"
      className="mb-4 rounded-md border border-warn/25 bg-warn-soft px-3 py-2 text-xs text-warn"
    >
      <p className="font-medium">Check your email to verify this address</p>
      <p className="mt-1">
        We sent a verification link when the account was created. Follow it to confirm your email,
        then sign in. Check spam if it has not arrived.
      </p>
      {error.body.request_id && (
        <p className="mt-1 font-mono text-2xs opacity-80">request_id: {error.body.request_id}</p>
      )}
    </div>
  );
}

export function LoginPage() {
  const navigate = useNavigate();
  const login = useLogin();
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginBody>({ defaultValues: { email: '', password: '' } });

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
    navigate('/orgs', { replace: true });
  });

  return (
    <AuthCard
      title="Sign in"
      description="Use your organization account."
      footer={
        <span>
          No account?{' '}
          <Link to="/register" className="font-medium text-accent hover:underline">
            Create one
          </Link>
        </span>
      }
    >
      <LoginError error={login.error} />
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-3.5">
        <Input
          label="Email"
          type="email"
          autoComplete="email"
          autoFocus
          required
          error={errors.email?.message}
          {...register('email', {
            required: 'Email is required',
            pattern: { value: /.+@.+\..+/, message: 'Enter a valid email address' },
          })}
        />
        <Input
          label="Password"
          type="password"
          autoComplete="current-password"
          required
          error={errors.password?.message}
          {...register('password', { required: 'Password is required' })}
        />
        <div className="-mt-1 text-right">
          <Link to="/forgot-password" className="text-xs text-ink-muted hover:text-ink">
            Forgot password?
          </Link>
        </div>
        <Button type="submit" variant="primary" loading={login.isPending} className="mt-1 w-full">
          Sign in
        </Button>
      </form>
    </AuthCard>
  );
}
