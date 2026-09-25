import { useForm } from 'react-hook-form';
import { Link } from 'react-router-dom';
import type { RegisterBody } from '../../types/api';
import { AuthCard, FormError } from './AuthCard';
import { AuthInput, AuthPasswordInput, AuthSubmit } from './AuthField';
import { useRegister } from './api';
import { ResendVerificationForm } from './ResendVerification';

/**
 * The state after the 202.
 *
 * Deliberately unconditional and says nothing about whether the address was
 * already registered: a distinguishable outcome — a different message, a
 * different route, an error — would hand an attacker the account-enumeration
 * oracle the 202 exists to close. If the address is taken, its real owner is
 * emailed a notice instead.
 *
 * The resend control is here because this is where people get stuck: the mail
 * is slow, or filtered, and the only other way to a new link was to try to
 * sign in and be refused. Exported for the test.
 */
export function RegistrationAccepted({ email }: { email: string }) {
  return (
    <AuthCard
      title="Check your email"
      description="If we can create an account for that address, a verification link is on its way. Follow it to confirm your email, then sign in."
      footer={
        <Link
          to="/login"
          className="rounded font-medium text-accent underline-offset-4 hover:underline"
        >
          Back to sign in
        </Link>
      }
    >
      <p className="mb-4 text-sm leading-relaxed text-ink-muted">
        Nothing arrived? Check spam, then try again in a few minutes.
      </p>
      <ResendVerificationForm email={email} locked />
    </AuthCard>
  );
}

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
  // `variables` is the body that was accepted, which is the address to offer
  // a resend for.
  if (registerUser.isSuccess) {
    return <RegistrationAccepted email={registerUser.variables?.email ?? ''} />;
  }

  return (
    <AuthCard
      title="Create an account"
      description="Your first organization is created with you as its owner."
      footer={
        <span>
          Already have an account?{' '}
          <Link
            to="/login"
            className="rounded font-medium text-accent underline-offset-4 hover:underline"
          >
            Sign in
          </Link>
        </span>
      }
    >
      <FormError error={registerUser.error} />
      <form
        onSubmit={handleSubmit((values) => registerUser.mutate(values))}
        noValidate
        className="flex flex-col gap-4"
      >
        <AuthInput
          label="Name"
          autoComplete="name"
          autoFocus
          required
          error={errors.name?.message}
          {...register('name', { required: 'Name is required' })}
        />
        <AuthInput
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
        <AuthInput
          label="Organization"
          autoComplete="organization"
          required
          hint="You can rename it later."
          error={errors.organization_name?.message}
          {...register('organization_name', { required: 'Organization name is required' })}
        />
        <AuthPasswordInput
          label="Password"
          autoComplete="new-password"
          required
          hint="At least 12 characters."
          error={errors.password?.message}
          {...register('password', {
            required: 'Password is required',
            minLength: { value: 12, message: 'Use at least 12 characters' },
          })}
        />
        <AuthSubmit loading={registerUser.isPending}>Create account</AuthSubmit>
      </form>
    </AuthCard>
  );
}
