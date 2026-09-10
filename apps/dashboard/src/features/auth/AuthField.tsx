import { forwardRef, useId, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Button, type ButtonProps } from '../../components';

/**
 * The auth-page form controls.
 *
 * These are NOT `components/Input.tsx`. The product baseline is a dense 13px
 * operator surface — an 8px-tall field in a settings panel is right there and
 * wrong here, where there are four inputs on the whole screen and one of them
 * is being typed into at 2am. Everything else is the same: the same tokens, the
 * same focus treatment, the same label/hint/error wiring `Field` does, so
 * nothing about the design system is forked, only the scale.
 *
 * The wiring that must not regress: a real `<label htmlFor>` per input (the
 * e2e suite finds every field by its label), `aria-describedby` pointing at
 * whichever of hint/error is showing, and `aria-invalid` when it is the error.
 */

const CONTROL =
  'h-11 w-full rounded-lg border bg-canvas px-3.5 text-[0.9375rem] leading-none text-ink ' +
  'placeholder:text-ink-subtle transition-colors duration-150 ' +
  // The global focus ring offsets against the canvas; on this screen the field
  // sits on `panel`, and a canvas-coloured halo would be a visible seam.
  'focus-visible:border-accent focus-visible:ring-offset-panel ' +
  'disabled:cursor-not-allowed disabled:bg-raised disabled:text-ink-subtle';

function fieldTone(invalid: boolean): string {
  return invalid ? 'border-danger' : 'border-line hover:border-line-strong';
}

interface ShellProps {
  id: string;
  label: string;
  /** Rendered opposite the label — the "Forgot password?" slot. */
  action?: ReactNode;
  hint?: ReactNode;
  hintId: string;
  error?: string;
  errorId: string;
  children: ReactNode;
}

function FieldShell({ id, label, action, hint, hintId, error, errorId, children }: ShellProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-xs font-medium text-ink-muted">
          {label}
        </label>
        {action}
      </div>
      {children}
      {hint && !error && (
        <p id={hintId} className="text-xs text-ink-subtle">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="flex items-start gap-1.5 text-xs font-medium text-danger">
          <AlertGlyph className="mt-px h-3.5 w-3.5 shrink-0" />
          {error}
        </p>
      )}
    </div>
  );
}

export interface AuthInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label: string;
  hint?: ReactNode;
  error?: string;
  action?: ReactNode;
}

export const AuthInput = forwardRef<HTMLInputElement, AuthInputProps>(function AuthInput(
  { label, hint, error, action, className, ...props },
  ref,
) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const invalid = Boolean(error);

  return (
    <FieldShell
      id={id}
      label={label}
      action={action}
      hint={hint}
      hintId={hintId}
      error={error}
      errorId={errorId}
    >
      <input
        ref={ref}
        id={id}
        aria-describedby={cn(hint && !error && hintId, error && errorId) || undefined}
        aria-invalid={invalid || undefined}
        {...props}
        className={cn(CONTROL, fieldTone(invalid), className)}
      />
    </FieldShell>
  );
});

/**
 * A password field you can read back.
 *
 * The toggle's accessible name is the visible word "Show"/"Hide" and nothing
 * else — no `aria-label` containing "password". That is not fussiness: the e2e
 * suite locates the field with `getByLabel('Password')`, which matches
 * `aria-label` as readily as a `<label>`, so a helpfully-worded button would
 * make the field ambiguous and the whole auth spec fail on a strictness error.
 */
export const AuthPasswordInput = forwardRef<HTMLInputElement, Omit<AuthInputProps, 'type'>>(
  function AuthPasswordInput({ label, hint, error, action, className, ...props }, ref) {
    const id = useId();
    const hintId = `${id}-hint`;
    const errorId = `${id}-error`;
    const invalid = Boolean(error);
    const [visible, setVisible] = useState(false);

    return (
      <FieldShell
        id={id}
        label={label}
        action={action}
        hint={hint}
        hintId={hintId}
        error={error}
        errorId={errorId}
      >
        <div className="relative">
          <input
            ref={ref}
            id={id}
            type={visible ? 'text' : 'password'}
            aria-describedby={cn(hint && !error && hintId, error && errorId) || undefined}
            aria-invalid={invalid || undefined}
            {...props}
            className={cn(CONTROL, fieldTone(invalid), 'pr-16', className)}
          />
          <button
            type="button"
            onClick={() => setVisible((shown) => !shown)}
            aria-pressed={visible}
            aria-controls={id}
            className={cn(
              'absolute right-1.5 top-1.5 h-8 rounded-md px-2.5 text-xs font-medium',
              'text-ink-muted transition-colors hover:bg-raised hover:text-ink',
            )}
          >
            {visible ? 'Hide' : 'Show'}
          </button>
        </div>
      </FieldShell>
    );
  },
);

/**
 * The one full-width action on an auth card. `Button` still owns the pending
 * state (spinner + `aria-busy`); this only restates the scale, so a submit
 * matches the 44px fields above it.
 */
export function AuthSubmit({ className, ...props }: ButtonProps) {
  return (
    <Button
      type="submit"
      variant="primary"
      {...props}
      className={cn(
        'mt-1 h-11 w-full rounded-lg text-sm font-semibold',
        'shadow-panel transition-transform active:scale-[0.995]',
        className,
      )}
    />
  );
}

/** Secondary action at auth scale, for "try this link again" and resends. */
export function AuthSecondary({ className, ...props }: ButtonProps) {
  return (
    <Button
      {...props}
      className={cn('h-10 rounded-lg px-3.5 text-sm font-medium', className)}
    />
  );
}

export function AlertGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 4.75v3.75" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="8" cy="11.1" r="0.9" fill="currentColor" />
    </svg>
  );
}

export function MailGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <rect
        x="1.75"
        y="3.25"
        width="12.5"
        height="9.5"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path
        d="m2.5 5 4.62 3.3a1.5 1.5 0 0 0 1.76 0L13.5 5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}
