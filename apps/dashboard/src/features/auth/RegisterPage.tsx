import { useForm } from 'react-hook-form';
import { Link } from 'react-router-dom';
import { Button, Input } from '../../components';
import type { RegisterBody } from '../../types/api';
import { AuthCard, FormError } from './AuthCard';
import { useRegister } from './api';

export function RegisterPage() {
  const registerUser = useRegister();
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<RegisterBody>({
    defaultValues: { name: '', email: '', password: '', organization_name: '' },
  });

  // Registration does not sign anyone in, so there is nothing to redirect to.
  // The confirmation below is deliberately unconditional and says nothing about
  // whether the address was already registered: a distinguishable outcome — a
  // different message, a different route, an error — would hand an attacker the
  // account-enumeration oracle the 202 exists to close. If the address is taken,
  // its real owner is emailed a notice instead.
  if (registerUser.isSuccess) {
    return (
      <AuthCard
        title="Check your email"
        description="If we can create an account for that address, a verification link is on its way. Follow it to confirm your email, then sign in."
        footer={
          <Link to="/login" className="font-medium text-accent hover:underline">
            Back to sign in
          </Link>
        }
      >
        <p className="text-xs text-ink-muted">
          Nothing arrived? Check spam, then try again in a few minutes.
        </p>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Create an account"
      description="Your first organization is created with you as its owner."
      footer={
        <span>
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-accent hover:underline">
            Sign in
          </Link>
        </span>
      }
    >
      <FormError error={registerUser.error} />
      <form
        onSubmit={handleSubmit((values) => registerUser.mutate(values))}
        noValidate
        className="flex flex-col gap-3.5"
      >
        <Input
          label="Name"
          autoComplete="name"
          autoFocus
          required
          error={errors.name?.message}
          {...register('name', { required: 'Name is required' })}
        />
        <Input
          label="Work email"
          type="email"
          autoComplete="email"
          required
          error={errors.email?.message}
          {...register('email', {
            required: 'Email is required',
            pattern: { value: /.+@.+\..+/, message: 'Enter a valid email address' },
          })}
        />
        <Input
          label="Organization"
          autoComplete="organization"
          required
          hint="You can rename it later."
          error={errors.organization_name?.message}
          {...register('organization_name', { required: 'Organization name is required' })}
        />
        <Input
          label="Password"
          type="password"
          autoComplete="new-password"
          required
          hint="At least 12 characters."
          error={errors.password?.message}
          {...register('password', {
            required: 'Password is required',
            minLength: { value: 12, message: 'Use at least 12 characters' },
          })}
        />
        <Button
          type="submit"
          variant="primary"
          loading={registerUser.isPending}
          className="mt-1 w-full"
        >
          Create account
        </Button>
      </form>
    </AuthCard>
  );
}
