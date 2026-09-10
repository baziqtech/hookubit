import { useForm } from 'react-hook-form';
import { Link } from 'react-router-dom';
import { Button, Input } from '../../components';
import type { ForgotPasswordBody } from '../../types/api';
import { AuthCard, FormError } from './AuthCard';
import { useForgotPassword } from './api';

export function ForgotPasswordPage() {
  const forgot = useForgotPassword();
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ForgotPasswordBody>({ defaultValues: { email: '' } });

  // Success is deliberately unconditional: telling the caller whether an
  // address exists turns this form into an account enumeration oracle.
  if (forgot.isSuccess) {
    return (
      <AuthCard
        title="Check your email"
        description="If that address has an account, a reset link is on its way. The link expires in 1 hour."
        footer={
          <Link to="/login" className="font-medium text-accent hover:underline">
            Back to sign in
          </Link>
        }
      >
        <p className="text-xs text-ink-muted">
          Nothing arrived? Check spam, then try again — repeated requests invalidate earlier links.
        </p>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Reset your password"
      description="We will email you a link to set a new one."
      footer={
        <Link to="/login" className="font-medium text-accent hover:underline">
          Back to sign in
        </Link>
      }
    >
      <FormError error={forgot.error} />
      <form
        onSubmit={handleSubmit((values) => forgot.mutate(values))}
        noValidate
        className="flex flex-col gap-3.5"
      >
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
        <Button type="submit" variant="primary" loading={forgot.isPending} className="mt-1 w-full">
          Send reset link
        </Button>
      </form>
    </AuthCard>
  );
}
