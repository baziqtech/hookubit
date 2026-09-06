import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from '../lib/cn';
import { Field } from './Field';

const BASE =
  'h-8 w-full rounded-md border bg-panel px-2.5 text-sm text-ink placeholder:text-ink-subtle ' +
  'transition-colors disabled:cursor-not-allowed disabled:bg-raised disabled:text-ink-subtle';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: string;
  hint?: ReactNode;
  error?: string;
  /** Monospace, for IDs, URLs, keys and anything else you would paste. */
  mono?: boolean;
  containerClassName?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, mono, className, containerClassName, required, ...props },
  ref,
) {
  const control = (ids?: { id: string; describedBy?: string; invalid: boolean }) => (
    <input
      ref={ref}
      id={ids?.id}
      aria-describedby={ids?.describedBy}
      aria-invalid={ids?.invalid || undefined}
      required={required}
      {...props}
      className={cn(
        BASE,
        mono && 'font-mono text-xs',
        ids?.invalid ? 'border-danger' : 'border-line hover:border-line-strong',
        className,
      )}
    />
  );

  if (!label) return control();

  return (
    <Field
      label={label}
      hint={hint}
      error={error}
      required={required}
      className={containerClassName}
    >
      {(ids) => control({ id: ids.id, describedBy: ids.describedBy, invalid: ids.invalid })}
    </Field>
  );
});
