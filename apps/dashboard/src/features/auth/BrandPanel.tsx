import { cn } from '../../lib/cn';
import { HookMark, WordmarkText } from './Wordmark';

/**
 * Three rows of the delivery record, as a still.
 *
 * Hand-written and static on purpose. It is not a screenshot, it does not
 * animate, and it is not a diagram of boxes and arrows — it is the actual
 * shape of the table this product is for, at the size it is read.
 *
 * Every row says something the prose above it cannot. One event reached three
 * endpoints, which is the fan-out. One of them is on its third attempt while
 * the other two are done, which is per-delivery retry. The attempt counts and
 * the durations are there because "we keep every attempt" is a claim, and a
 * claim beside evidence reads differently from a claim alone.
 */
const SAMPLE = [
  { endpoint: 'ledger-eu', state: 'Delivered', tone: 'ok', attempts: '1 / 5', duration: '142ms' },
  { endpoint: 'partner-acme', state: 'Retrying', tone: 'warn', attempts: '3 / 5', duration: '10.0s' },
  { endpoint: 'archive-s3', state: 'Delivered', tone: 'ok', attempts: '1 / 5', duration: '88ms' },
] as const;

const TONE: Record<string, string> = {
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
};

/**
 * The half of the sign-in screen that is not a form.
 *
 * ## Why there is one again
 *
 * An earlier version of this screen was a split with an animated delivery
 * diagram, a dot grid, an accent glow and a feature checklist. It was removed
 * because it was the house style of every generated SaaS login and read as one.
 * Removing it left a centred column that was honest and said nothing.
 *
 * This is the third answer and it is a different KIND of thing: the panel's
 * content is the product's own record, drawn at the size it is actually read.
 * One event, three endpoints, one of them retrying. Somebody who has never
 * seen this product learns what it does from the table, not from an adjective.
 *
 * ## Why it is hidden below `lg`
 *
 * On a phone it would push the form below the fold, and the person on a phone
 * is signing in, not evaluating. The tagline comes with them; the rest does
 * not.
 */
export function BrandPanel({ className }: { className?: string }) {
  return (
    <aside
      className={cn(
        'relative hidden min-h-screen flex-col justify-between border-r border-line bg-panel px-10 py-12 lg:flex',
        className,
      )}
    >
      <span className="flex items-center gap-2.5">
        <HookMark />
        <WordmarkText />
      </span>

      <div className="flex max-w-md flex-col gap-7">
        {/*
          The largest thing on the screen is a sentence. The brand screen is
          explicit that the tagline belongs on outward-facing surfaces and
          never inside the product shell, where it would only take up room.
        */}
        <h2 className="text-hero font-semibold tracking-tight text-ink">
          A call that is never lost
        </h2>

        <div className="flex flex-col gap-2">
          <p className="text-sm font-semibold text-ink">Proof of every attempt</p>
          <p className="text-xs leading-relaxed text-ink-muted">
            We send your events, retry the ones that fail, and keep a record of every attempt: the
            response code, the body, how long it took, and when.
          </p>
        </div>

        <div className="overflow-hidden rounded-[0.625rem] border border-line bg-canvas">
          {SAMPLE.map((row, index) => (
            <div
              key={row.endpoint}
              className={cn(
                'flex items-center gap-3 px-3.5 py-2.5 text-2xs',
                index > 0 && 'border-t border-line',
              )}
            >
              <span className="w-28 shrink-0 truncate font-medium text-ink">{row.endpoint}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-ink-subtle">
                payment.settled
              </span>
              <span
                className={cn(
                  'shrink-0 rounded px-1.5 py-0.5 font-semibold',
                  TONE[row.tone],
                )}
              >
                {row.state}
              </span>
              <span className="w-10 shrink-0 text-right tabular text-ink-subtle">
                {row.attempts}
              </span>
              <span className="w-12 shrink-0 text-right tabular text-ink-muted">
                {row.duration}
              </span>
            </div>
          ))}
        </div>

        <p className="text-2xs text-ink-subtle">
          One event published · one delivery per matching subscription · each retries on its own
        </p>
      </div>

      <span aria-hidden="true" />
    </aside>
  );
}
