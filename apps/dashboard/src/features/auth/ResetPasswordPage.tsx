import { useForm } from 'react-hook-form';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Button, Input } from '../../components';
import { AuthCard, FormError } from './AuthCard';
import { useResetPassword } from './api';

interface ResetForm {
  password: string;
  confirmation: string;
}

export function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const navigate = useNavigate();
  const reset = useResetPassword();

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<ResetForm>({ defaultValues: { password: '', confirmation: '' } });

  if (!token) {
    return (
      <AuthCard
        title="This link is not valid"
        description="The reset link is missing its token. Request a new one."
        footer={
          <Link to="/forgot-password" className="font-medium text-accent hover:underline">
            Request a new link
          </Link>
        }
      >
        <p className="text-xs text-ink-muted">
          Links expire 30 minutes after they are issued, and requesting a new link invalidates the
          previous one.
        </p>
      </AuthCard>
    );
  }

  const onSubmit = handleSubmit(async (values) => {
    await reset.mutateAsync({ token, password: values.password });
    navigate('/login', { replace: true });
  });

  return (
    <AuthCard title="Set a new password" description="You will be signed out of other sessions.">
      <FormError error={reset.error} />
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-3.5">
        <Input
          label="New password"
          type="password"
          autoComplete="new-password"
          autoFocus
          required
          hint="At least 12 characters."
          error={errors.password?.message}
          {...register('password', {
            required: 'Password is required',
            minLength: { value: 12, message: 'Use at least 12 characters' },
          })}
        />
        <Input
          label="Confirm password"
          type="password"
          autoComplete="new-password"
          required
          error={errors.confirmation?.message}
          {...register('confirmation', {
            required: 'Confirm the password',
            validate: (value) => value === watch('password') || 'Passwords do not match',
          })}
        />
        <Button type="submit" variant="primary" loading={reset.isPending} className="mt-1 w-full">
          Set password
        </Button>
      </form>
    </AuthCard>
  );
}
