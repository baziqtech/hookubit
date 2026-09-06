import { useId, type ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface FieldProps {
  label: string;
  /** Rendered under the control, and announced via `aria-describedby`. */
  hint?: ReactNode;
  error?: string;
  required?: boolean;
  className?: string;
  /** Receives the wiring the control needs to be labelled and described. */
  children: (ids: {
    id: string;
    describedBy: string | undefined;
    invalid: boolean;
  }) => ReactNode;
}

/**
 * One label/hint/error wrapper for every control, so accessibility wiring is
 * done once rather than remembered at each call site.
 */
export function Field({ label, hint, error, required, className, children }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = cn(hint && hintId, error && errorId) || undefined;

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-xs font-medium text-ink-muted">
        {label}
        {required && (
          <span className="ml-0.5 text-danger" aria-hidden="true">
            *
          </span>
        )}
      </label>
      {children({ id, describedBy, invalid: Boolean(error) })}
      {hint && !error && (
        <p id={hintId} className="text-xs text-ink-subtle">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
