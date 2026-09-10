import { cn } from '../../lib/cn';

/**
 * The product mark, drawn once: a fishing hook, in `currentColor`, with no
 * container of its own so each caller can set it in whatever square it needs.
 *
 * Deliberately a shape rather than a letter — the old `W` avatar was a
 * placeholder that outlived the name it stood for, and a single letter in a
 * rounded square is what every internal tool looks like.
 *
 * THE EYE IS THE WHOLE TRICK. A shank with a bend and a barb is geometrically
 * a letter J, and every draft without the eye read as one — at 20px the barb
 * is far too small to carry the distinction by itself. The open loop at the
 * top is the one feature a J does not have, so it is what makes the shape
 * legible as a hook all the way down to favicon size.
 *
 * The same geometry is duplicated once, deliberately, in `public/favicon.svg`:
 * a favicon is a separate document and can read neither this component nor the
 * theme's custom properties. Change one, change the other.
 */
export function HookGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      {/* Eye. */}
      <circle cx="14.8" cy="5.6" r="2.9" stroke="currentColor" strokeWidth="1.9" />
      {/* Shank, bend, and the point turning back up. */}
      <path
        d="M14.8 8.5v4.2a3.9 3.9 0 0 1-7.8 0v-2.4"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* The barb, spurring back down off the point. */}
      <path d="m7 10.3 2.6 2.6" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  );
}

/** The glyph in its accent square, as the auth pages use it. */
export function HookMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[0.625rem]',
        'bg-accent text-accent-ink shadow-panel ring-1 ring-inset ring-white/15',
        className,
      )}
    >
      <HookGlyph className="h-[1.25rem] w-[1.25rem]" />
    </span>
  );
}

/**
 * `HookuBit`, cased exactly, next to the mark. One component so the casing is
 * stated in a single place.
 */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <HookMark />
      <span className="text-[0.9375rem] font-semibold tracking-tight text-ink">HookuBit</span>
    </span>
  );
}
