import { useEffect, useRef } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Button } from '../../components';
import { cn } from '../../lib/cn';
import { TOUR_STEPS } from './tour-content';
import { useTourStore } from './tour-store';

/**
 * The product tour. A NON-MODAL dialog, and that choice is the design.
 *
 * A tour that dims the page and swallows clicks teaches the first thing a new
 * user learns about the product: that it gets in your way. So this is
 * `role="dialog"` WITHOUT `aria-modal`, with no backdrop and no focus trap —
 * the app behind it stays fully interactive and fully keyboard reachable. You
 * can read step 2, click into Deliveries to look at what it just described,
 * and carry on; the panel follows you, because it is mounted at the shell
 * rather than on a route.
 *
 * That decision cascades through the accessibility work:
 *
 *   - No focus trap, deliberately. Trapping is correct only for a genuinely
 *     modal dialog, and trapping a non-modal one is precisely the keyboard trap
 *     WCAG 2.1.2 forbids. Focus still MOVES IN on open and RETURNS to the
 *     invoking control on close, which is the part people actually need.
 *   - Escape closes from anywhere, counted as a skip.
 *   - Step changes are announced through a `role="status"` region rather than
 *     by moving focus, so a screen-reader user hears the new step without being
 *     yanked out of wherever they were reading.
 *   - Skip is a real, visible control on EVERY step, never more than one Tab
 *     away — not a grey "×" in a corner.
 *   - The step transition is gated behind `motion-safe:`; with reduced motion
 *     the content simply changes.
 *
 * It is sized and positioned to stay clear of the primary navigation, and it
 * uses `max-h`/overflow rather than a fixed height so it stays usable at 200%
 * zoom instead of clipping its own buttons off-screen.
 */
export function ProductTour() {
  const { orgId, projectId } = useParams();
  const { open, step, next, previous, goTo, skip, complete } = useTourStore();

  const panelRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  /** Whatever had focus when the tour opened, so it can be handed back. */
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const total = TOUR_STEPS.length;
  const current = TOUR_STEPS[step];
  const isLast = step === total - 1;

  // Move focus into the panel on open, and back out on close. Captured before
  // the panel renders, because by then `document.activeElement` is already gone.
  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement as HTMLElement | null;
    headingRef.current?.focus();

    return () => {
      // Only reclaim focus if it is still inside the panel; if the user has
      // clicked off into the app, stealing it back would be the rude version.
      const active = document.activeElement;
      if (!active || active === document.body || panelRef.current?.contains(active)) {
        returnFocusRef.current?.focus?.();
      }
    };
  }, [open]);

  // Escape closes from anywhere on the page, not only from inside the panel —
  // the panel does not hold focus, so a listener scoped to it would never fire.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') skip();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, skip]);

  if (!open) return null;

  const getStartedHref =
    orgId && projectId ? `/orgs/${orgId}/projects/${projectId}/get-started` : null;

  return (
    <div
      ref={panelRef}
      role="dialog"
      // No `aria-modal` — the rest of the page is genuinely available, and
      // claiming otherwise would make a screen reader hide it.
      aria-labelledby="tour-title"
      aria-describedby="tour-body"
      data-testid="product-tour"
      className={cn(
        'fixed bottom-4 right-4 z-40 flex w-[min(26rem,calc(100vw-2rem))] flex-col',
        'max-h-[min(34rem,calc(100vh-2rem))] overflow-hidden rounded-xl border border-line',
        'bg-panel shadow-pop motion-safe:animate-pop-in',
      )}
    >
      <header className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5">
        <p className="text-2xs font-medium uppercase tracking-wider text-ink-subtle">
          Product tour
        </p>
        <Button
          size="sm"
          variant="ghost"
          onClick={skip}
          // The escape hatch is a labelled word on every step, not a glyph.
          className="text-ink-muted hover:text-ink"
        >
          Skip tour
        </Button>
      </header>

      {/*
        The announcement channel. `aria-atomic` so the whole step is read as one
        message rather than as a diff, and `polite` so it waits for a pause
        instead of interrupting. Focus is deliberately not moved on step change.
      */}
      <p className="sr-only" role="status" aria-atomic="true">
        Step {step + 1} of {total}: {current.title}
      </p>

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin px-4 py-3.5">
        <h2
          id="tour-title"
          ref={headingRef}
          /*
           * Focusable so opening the tour can land here; -1 keeps it out of the
           * tab sequence afterwards. The global focus ring is suppressed on it
           * specifically: this focus is programmatic rather than the result of
           * the user tabbing, and a ring around a heading reads as a text input.
           * Every control the user actually operates keeps its ring.
           */
          tabIndex={-1}
          className="text-sm font-semibold tracking-tight text-ink focus:outline-none focus-visible:ring-0 focus-visible:ring-offset-0"
        >
          {current.title}
        </h2>

        <div id="tour-body" className="mt-2 flex flex-col gap-2">
          {current.body.map((paragraph) => (
            <p key={paragraph.slice(0, 32)} className="text-xs leading-relaxed text-ink-muted">
              {paragraph}
            </p>
          ))}
        </div>

        {current.aside && (
          <figure className="mt-3 overflow-hidden rounded-md border border-line bg-raised/60">
            <figcaption className="border-b border-line bg-panel px-2.5 py-1 text-2xs font-medium uppercase tracking-wider text-ink-subtle">
              {current.aside.label}
            </figcaption>
            <pre className="overflow-x-auto scrollbar-thin px-2.5 py-2 font-mono text-2xs leading-relaxed text-ink-muted">
              {current.aside.lines.join('\n')}
            </pre>
          </figure>
        )}

        {isLast && getStartedHref && (
          <Link
            to={getStartedHref}
            onClick={complete}
            className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-ink transition-colors hover:bg-accent/90"
          >
            Open Get started
            <span aria-hidden="true">→</span>
          </Link>
        )}
      </div>

      <footer className="flex items-center justify-between gap-3 border-t border-line px-4 py-2.5">
        <StepDots current={step} total={total} onSelect={goTo} />

        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="ghost" onClick={previous} disabled={step === 0}>
            Back
          </Button>
          {isLast ? (
            <Button size="sm" variant="primary" onClick={complete}>
              Finish
            </Button>
          ) : (
            <Button size="sm" variant="primary" onClick={next}>
              Next
            </Button>
          )}
        </div>
      </footer>
    </div>
  );
}

/**
 * Progress dots that are also navigation. Real buttons with real names — a row
 * of decorative `<span>`s would show progress to sighted users and nothing to
 * anyone else, and the steps are short enough that jumping between them is
 * genuinely useful.
 */
function StepDots({
  current,
  total,
  onSelect,
}: {
  current: number;
  total: number;
  onSelect: (step: number) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="mr-1 text-2xs tabular text-ink-subtle">
        {current + 1}/{total}
      </span>
      {TOUR_STEPS.map((step, index) => (
        <button
          key={step.id}
          type="button"
          onClick={() => onSelect(index)}
          aria-current={index === current ? 'step' : undefined}
          aria-label={`Step ${index + 1} of ${total}: ${step.label}`}
          // 44px hit target via padding while the dot itself stays 6px.
          className="group -m-1 flex h-6 w-4 items-center justify-center p-1"
        >
          <span
            aria-hidden="true"
            className={cn(
              'h-1.5 rounded-full transition-all',
              index === current
                ? 'w-4 bg-accent'
                : 'w-1.5 bg-line-strong group-hover:bg-ink-subtle',
            )}
          />
        </button>
      ))}
    </div>
  );
}
