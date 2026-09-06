import { useForm } from 'react-hook-form';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Input } from '../../components';
import type { LoginBody } from '../../types/api';
import { AuthCard, FormError } from './AuthCard';
import { useLogin } from './api';

export function LoginPage() {
  const navigate = useNavigate();
  const login = useLogin();
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginBody>({ defaultValues: { email: '', password: '' } });

  const onSubmit = handleSubmit(async (values) => {
    const session = await login.mutateAsync(values);
    // The session response carries the org list, so we can land the user
    // somewhere real instead of on an "org selection" dead end.
    const first = session.organizations[0];
    navigate(first ? `/orgs/${first.id}` : '/orgs', { replace: true });
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
      <FormError error={login.error} />
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
