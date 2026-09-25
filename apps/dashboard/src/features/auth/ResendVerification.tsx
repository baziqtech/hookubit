import { forwardRef, useEffect, useRef } from 'react';
import { useForm } from 'react-hook-form';
import type { ResendVerificationBody } from '../../types/api';
import { FormError } from './AuthCard';
import { AuthInput, AuthSecondary, AuthSubmit } from './AuthField';
import { useResendVerification } from './api';

/**
 * The 202 acknowledgement, and the ONLY wording allowed for it.
 *
 * `POST /v1/auth/resend-verification` answers the same 202 whether the address
 * is registered, unknown, already verified or disabled — the route exists in
 * that shape precisely so it cannot be used to enumerate accounts. Copy that
 * says "we found your account" or "a link has been sent" undoes that on the
 * client: it turns an indistinguishable response into a confirmation. So this
 * is conditional on its face — "if that address has an account waiting to be
 * verified" — the same construction `ForgotPasswordPage` uses for the same
 * reason, and the test pins it.
 *
 * `role="status"` so the change is announced without stealing focus; the
 * form that renders it moves focus here deliberately, because the control the
 * user just pressed is gone.
 */
export const ResendAcknowledgement = forwardRef<HTMLDivElement>(function ResendAcknowledgement(
  _props,
  ref,
) {
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="status"
      data-testid="resend-acknowledged"
      className="rounded-xl border border-line bg-raised/70 px-3.5 py-3 text-sm leading-relaxed text-ink-muted focus:outline-none"
    >
      <p className="font-medium text-ink">Check your inbox</p>
      <p className="mt-1.5">
        If that address has an account waiting to be verified, a fresh link is on its way. Only
        the newest link works; any earlier one has been cancelled.
      </p>
      <p className="mt-1.5">Nothing arrived? Check spam, then try again in a few minutes.</p>
    </div>
  );
});

export interface ResendVerificationFormProps {
  /** Address to send to — what the user typed on the form that got them here. */
  email?: string;
  /**
   * Show the address as text with a single button, rather than an editable
   * field. For the login and register pages, where the user typed it a moment
   * ago and retyping it would be the annoying version.
   */
  locked?: boolean;
}

/**
 * "Send me a new verification link."
 *
 * Two modes, one mutation. Locked: the address is known and the whole control
 * is a button naming it. Editable: a labelled email field, for the verify page,
 * where the link carried a token and no address.
 */
export function ResendVerificationForm({ email = '', locked = false }: ResendVerificationFormProps) {
  const resend = useResendVerification();
  const acknowledgementRef = useRef<HTMLDivElement>(null);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ResendVerificationBody>({ defaultValues: { email } });

  // The button the user pressed has been replaced by the acknowledgement;
  // focus follows it so the outcome is read rather than silently swapped in.
  useEffect(() => {
    if (resend.isSuccess) acknowledgementRef.current?.focus();
  }, [resend.isSuccess]);

  if (resend.isSuccess) return <ResendAcknowledgement ref={acknowledgementRef} />;

  if (locked) {
    return (
      <div data-testid="resend-verification">
        <FormError error={resend.error} />
        <AuthSecondary
          type="button"
          variant="secondary"
          loading={resend.isPending}
          onClick={() => resend.mutate({ email })}
          className="max-w-full"
        >
          <span className="truncate">Send a new link to {email}</span>
        </AuthSecondary>
      </div>
    );
  }

  return (
    <form
      data-testid="resend-verification"
      onSubmit={handleSubmit((values) => resend.mutate(values))}
      noValidate
      className="flex flex-col gap-4"
    >
      <FormError error={resend.error} />
      <AuthInput
        label="Email"
        type="email"
        autoComplete="email"
        required
        placeholder="you@company.com"
        error={errors.email?.message}
        {...register('email', {
          required: 'Email is required',
          pattern: { value: /.+@.+\..+/, message: 'Enter a valid email address' },
        })}
      />
      <AuthSubmit loading={resend.isPending}>Send a new link</AuthSubmit>
    </form>
  );
}
