import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '../lib/cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md';
type Shape = 'default' | 'pill';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-accent-ink hover:bg-accent/90 border border-transparent',
  secondary: 'bg-panel text-ink border border-line hover:bg-raised hover:border-line-strong',
  ghost: 'bg-transparent text-ink-muted border border-transparent hover:bg-raised hover:text-ink',
  danger: 'bg-danger text-white hover:bg-danger/90 border border-transparent',
};

const SIZES: Record<Size, string> = {
  sm: 'h-7 px-2.5 text-xs gap-1.5',
  md: 'h-8 px-3 text-sm gap-2',
};

/**
 * Radius is its own axis rather than part of the size, because `cn` is a plain
 * joiner (see its docblock): two border-radius utilities on one element both
 * survive and the generated CSS order decides which lands, which is not
 * something a caller can reason about. Exactly one is chosen here.
 */
const SHAPES: Record<Shape, string> = {
  default: 'rounded-md',
  pill: 'rounded-full',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /** `pill` is the auth pages; everything in the operator shell is `default`. */
  shape?: Shape;
  /** Shows a spinner and blocks interaction without changing layout width. */
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    shape = 'default',
    loading = false,
    icon,
    className,
    children,
    ...props
  },
  ref,
) {
  const disabled = props.disabled || loading;
  return (
    <button
      ref={ref}
      type={props.type ?? 'button'}
      {...props}
      disabled={disabled}
      // `aria-busy` rather than swapping the label, so a screen reader is told
      // the control is working instead of hearing the name change under it.
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex select-none items-center justify-center whitespace-nowrap font-medium',
        'transition-colors duration-75 disabled:pointer-events-none disabled:opacity-50',
        VARIANTS[variant],
        SIZES[size],
        SHAPES[shape],
        className,
      )}
    >
      {loading ? <Spinner /> : icon}
      {children}
    </button>
  );
});

function Spinner() {
  return (
    <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
      <path
        d="M14.5 8A6.5 6.5 0 0 0 8 1.5"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
