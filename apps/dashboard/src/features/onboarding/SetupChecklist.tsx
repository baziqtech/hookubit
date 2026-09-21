import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '../../lib/cn';
import { setupProgress, type SetupStep, type SetupStepState } from './setup';

/**
 * The guided path, rendered as an ordered list because it IS one — each step
 * depends on the one above it, and a set of unordered cards would hide that.
 *
 * Every row states the CONCEPT before the action. "Subscription" means nothing
 * on first contact; "the routing rule: which event types an endpoint should
 * receive" means something immediately, and it is the sentence that stops
 * someone publishing an event into a project that will silently drop it.
 */

const STATE_LABEL: Record<SetupStepState, string> = {
  done: 'Done',
  attention: 'Needs attention',
  current: 'Do this next',
  todo: 'Not started',
};

export interface SetupChecklistProps {
  steps: SetupStep[];
  /** Route per step, so "do this next" is one click rather than a hunt. */
  hrefFor: (step: SetupStep) => string | null;
  className?: string;
}

export function SetupChecklist({ steps, hrefFor, className }: SetupChecklistProps) {
  const progress = setupProgress(steps);

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <ProgressBar done={progress.done} total={progress.total} />

      <ol className="flex flex-col gap-2">
        {steps.map((step, index) => (
          <li key={step.id}>
            <StepRow step={step} index={index + 1} href={hrefFor(step)} />
          </li>
        ))}
      </ol>
    </div>
  );
}

function ProgressBar({ done, total }: { done: number; total: number }) {
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <div className="flex items-center gap-3">
      <div
        className="h-1.5 flex-1 overflow-hidden rounded-full bg-raised"
        role="progressbar"
        aria-valuenow={done}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-label="Setup progress"
      >
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-300"
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className="shrink-0 text-2xs tabular text-ink-subtle">
        {done} of {total}
      </span>
    </div>
  );
}

function StepRow({ step, index, href }: { step: SetupStep; index: number; href: string | null }) {
  const active = step.state === 'current' || step.state === 'attention';

  const body = (
    <div
      className={cn(
        'flex items-start gap-3 rounded-lg border px-3.5 py-3 transition-colors',
        step.state === 'current' && 'border-accent/50 bg-accent-soft/40',
        step.state === 'attention' && 'border-warn/40 bg-warn-soft/40',
        step.state === 'done' && 'border-line bg-panel',
        step.state === 'todo' && 'border-line bg-panel opacity-70',
        href && 'hover:border-line-strong',
      )}
    >
      <StepMarker state={step.state} index={index} />

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-xs font-semibold text-ink">{step.title}</span>
          <span
            className={cn(
              'rounded border px-1.5 py-px text-2xs font-medium leading-none',
              step.state === 'done' && 'border-ok/25 bg-ok-soft text-ok',
              step.state === 'attention' && 'border-warn/25 bg-warn-soft text-warn',
              step.state === 'current' && 'border-accent/30 bg-accent-soft text-accent',
              step.state === 'todo' && 'border-line bg-raised text-ink-subtle',
            )}
          >
            {STATE_LABEL[step.state]}
          </span>
        </div>

        <p className="mt-1 text-xs leading-relaxed text-ink-muted">{step.concept}</p>

        {step.watching && step.state !== 'done' && (
          <p className="mt-1.5 flex items-center gap-1.5 text-2xs text-ink-subtle">
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent"
            />
            Watching for your first event — this page updates on its own the moment one arrives.
          </p>
        )}

        {step.evidence && (
          <p className="mt-1.5 text-2xs text-ink-subtle">
            <span className="text-ink-muted">{step.evidence}</span>
          </p>
        )}

        {step.warning && (
          <p className="mt-1.5 rounded border border-warn/30 bg-warn-soft px-2 py-1 text-2xs leading-relaxed text-warn">
            {step.warning}
          </p>
        )}

        {active && !step.evidence && (
          <p className="mt-1.5 text-2xs font-medium text-ink">{step.action}</p>
        )}
      </div>

      {href && (
        <span
          aria-hidden="true"
          className="mt-0.5 shrink-0 text-ink-subtle transition-transform group-hover:translate-x-0.5"
        >
          <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none">
            <path
              d="m6 3.5 4.5 4.5L6 12.5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      )}
    </div>
  );

  return href ? <StepLink href={href}>{body}</StepLink> : body;
}

/**
 * The whole row is the link, not a small "Go" button — the target area for
 * "do this next" should be the size of the thing it describes.
 */
function StepLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link to={href} className="group block rounded-lg">
      {children}
    </Link>
  );
}

function StepMarker({ state, index }: { state: SetupStepState; index: number }) {
  if (state === 'done') {
    return (
      <span
        className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-ok/30 bg-ok-soft text-ok"
        aria-hidden="true"
      >
        <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none">
          <path
            d="m2.5 6.2 2.3 2.3 4.7-5"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    );
  }

  return (
    <span
      aria-hidden="true"
      className={cn(
        'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-2xs font-semibold tabular',
        state === 'attention' && 'border-warn/40 bg-warn-soft text-warn',
        state === 'current' && 'border-accent/40 bg-accent text-accent-ink',
        state === 'todo' && 'border-line bg-raised text-ink-subtle',
      )}
    >
      {state === 'attention' ? '!' : index}
    </span>
  );
}

/** Re-exported so `StepRow` can stay private while the link wrapper is reused. */
export { StepLink };
