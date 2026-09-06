import { forwardRef, type ReactNode, type SelectHTMLAttributes } from 'react';
import { cn } from '../lib/cn';
import { Field } from './Field';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  label?: string;
  hint?: ReactNode;
  error?: string;
  options: SelectOption[];
  /** Leading blank option, e.g. "All statuses". */
  placeholder?: string;
  containerClassName?: string;
}

/**
 * A real `<select>`. A custom listbox would buy styling and cost keyboard
 * behaviour, type-ahead, and mobile pickers that the platform gives free.
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, hint, error, options, placeholder, className, containerClassName, required, ...props },
  ref,
) {
  const control = (ids?: { id: string; describedBy?: string; invalid: boolean }) => (
    <div className={cn('relative', !label && className)}>
      <select
        ref={ref}
        id={ids?.id}
        aria-describedby={ids?.describedBy}
        aria-invalid={ids?.invalid || undefined}
        required={required}
        {...props}
        className={cn(
          'h-8 w-full appearance-none rounded-md border bg-panel py-0 pl-2.5 pr-7 text-sm text-ink',
          'transition-colors disabled:cursor-not-allowed disabled:bg-raised disabled:text-ink-subtle',
          ids?.invalid ? 'border-danger' : 'border-line hover:border-line-strong',
          label && className,
        )}
      >
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      <Chevron />
    </div>
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

function Chevron() {
  return (
    <svg
      className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-ink-subtle"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
    >
      <path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
