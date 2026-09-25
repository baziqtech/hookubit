import type { ReactNode, RefObject } from 'react';
import { cn } from '../../lib/cn';
import { ApiRequestError } from '../../lib/api';
import { AlertGlyph } from './AuthField';

/**
 * The content of an auth page: a headline, a sentence, the form, and a way
 * back out.
 *
 * There is deliberately no box any more. The old card — a 22rem bordered panel
 * on an empty canvas — was doing the job of separating the form from nothing,
 * and it made a sign-in read like a settings dialog. `AuthLayout` now owns the
 * composition, and the column IS the card: the page is `canvas` and the fields
 * are `panel`, so the elevation reads the same way in light and dark rather
 * than inverting (`raised` is lighter than `panel` in one theme and darker in
 * the other, which is exactly the trap a nested card falls into here).
 *
 * Every auth page shares this, including `AcceptInvitationPage`, so the type
 * is unchanged and every existing caller keeps working.
 */
export function AuthCard({
  icon,
  title,
  description,
  children,
  footer,
  titleRef,
}: {
  /**
   * A status badge above the headline, for the transactional cards
   * (verifying / verified / this link is dead) where the outcome is the
   * headline's whole point. Purely decorative — the heading still carries the
   * meaning, and pages that have no outcome to report pass nothing.
   */
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /**
   * Makes the heading programmatically focusable so a page that changes state
   * WITHOUT navigating — verifying, then verified — can land focus on the new
   * headline. Without it a screen-reader user hears nothing when the card
   * swaps, and a keyboard user is left focused on whatever just disappeared.
   * `-1` keeps it out of the tab order; the focus ring is suppressed because
   * this focus is programmatic, not the result of tabbing.
   */
  titleRef?: RefObject<HTMLHeadingElement>;
}) {
  return (
    <div className="animate-fade-in">
      {/*
        The header block is centred and the form below it is not, because the
        labels have to start at the same left edge as the inputs they name.
        That is the same arrangement Convoy and Antigravity use for a centred
        hero over left-aligned content.
      */}
      <div className="text-center">
        {icon && <div className="mb-6 flex justify-center">{icon}</div>}
        <h1
          ref={titleRef}
          tabIndex={titleRef ? -1 : undefined}
          className={cn(
            // `text-hero` (34px/500) is the top of the design's own scale.
            // It used to be an arbitrary text-[2.5rem]; the scale has display
            // sizes now, so headlines stop being one-offs.
            'text-hero font-medium text-ink',
            titleRef && 'focus:outline-none focus-visible:ring-0 focus-visible:ring-offset-0',
          )}
        >
          {title}
        </h1>
        {description && (
          <p className="mt-4 text-[0.9375rem] leading-relaxed text-ink-muted">
            {description}
          </p>
        )}
      </div>
      <div className="mt-9">{children}</div>
      {footer && (
        <div className="mt-8 border-t border-line pt-6 text-center text-sm text-ink-muted">
          {footer}
        </div>
      )}
    </div>
  );
}

/**
 * Form-level failure, rendered directly above the fields — where the eye
 * already is after pressing submit, rather than at the bottom of the page.
 *
 * Always prints `request_id` when the server sent one: it is the only handle
 * support has on what actually happened.
 */
export function FormError({ error }: { error: unknown }) {
  if (!error) return null;

  const isApi = error instanceof ApiRequestError;
  const message = isApi
    ? error.body.message
    : error instanceof Error
      ? error.message
      : 'Something went wrong.';
  const requestId = isApi ? error.body.request_id : undefined;

  return (
    <div
      role="alert"
      className="mb-5 rounded-xl border border-danger/25 bg-danger-soft px-3.5 py-3 text-sm text-danger"
    >
      <div className="flex gap-2.5">
        <AlertGlyph className="mt-0.5 h-4 w-4 shrink-0" />
        <p className="min-w-0">{message}</p>
      </div>
      {/* Full width, under the message rather than indented beside the icon:
          a request id is 40-odd unbreakable characters and the indent is the
          difference between one line and an orphaned letter on a second. */}
      {requestId && (
        <p className="mt-2 break-all border-t border-danger/20 pt-2 font-mono text-2xs opacity-80">
          request_id: {requestId}
        </p>
      )}
    </div>
  );
}
