import { cn } from '../../lib/cn';

/**
 * The right-hand half of the sign-in screen: what this product actually does,
 * drawn rather than described.
 *
 * Everything on it is true of the system as built — one published event is
 * materialised into one delivery row per matching subscription, each with its
 * own retry chain and its own attempt history, and every attempt is signed
 * with the headers `docs/API.md` documents. Nothing here is a metric, a
 * customer or a logo, because none of those would be true, and a sign-in
 * screen that lies is a bad first impression of an infrastructure product.
 *
 * It is decorative for assistive technology (`aria-hidden` on the diagram) and
 * hidden outright below `lg`, where the form is the only thing worth the
 * viewport.
 */

/** One row of the fan-out. Geometry is fixed so the SVG needs no measuring. */
interface Branch {
  name: string;
  url: string;
  attempt: string;
  chip: string;
  tone: 'ok' | 'warn';
}

const BRANCHES: Branch[] = [
  {
    name: 'finance-ledger',
    url: 'ledger.internal/hooks/shaq',
    attempt: 'attempt 1',
    chip: '200 OK',
    tone: 'ok',
  },
  {
    name: 'ops-notifier',
    url: 'ops.internal/webhooks',
    attempt: 'attempt 1',
    chip: '200 OK',
    tone: 'ok',
  },
  {
    name: 'partner-sandbox',
    url: 'sandbox.partner.test/hook',
    attempt: 'next try in 4s',
    chip: '502 · retrying',
    tone: 'warn',
  },
];

const ROW_TOPS = [84, 148, 212];
const ROW_HEIGHT = 44;
const TRUNK_X = 24;

function centreOf(index: number): number {
  return ROW_TOPS[index] + ROW_HEIGHT / 2;
}

function FanOutDiagram() {
  const lastCentre = centreOf(BRANCHES.length - 1);

  return (
    <svg
      viewBox="0 0 400 262"
      className="w-full"
      /*
       * Decorative, not informative: the headline and the paragraph beside it
       * already say what the picture says. An `aria-label` here would also be
       * matched by Playwright's `getByLabel`, which the auth e2e run uses to
       * find the form's own fields — a diagram is not worth that risk.
       */
      aria-hidden="true"
    >
      {/* ── the published event ─────────────────────────────────────────── */}
      <rect x="1" y="1" width="398" height="54" rx="12" className="fill-raised stroke-line" />
      <circle cx="24" cy="28" r="4" className="fill-accent" />
      <circle cx="24" cy="28" r="4" className="fill-accent hb-ping" />
      <text x="40" y="25" fontSize="13" className="fill-ink font-medium">
        payment.settled
      </text>
      <text x="40" y="41" fontSize="10" className="fill-ink-subtle font-mono">
        evt_01JQ8ZK4M2GQ
      </text>
      <text x="382" y="33" fontSize="10" textAnchor="end" className="fill-ink-muted">
        3 deliveries
      </text>

      {/* ── trunk and branches ──────────────────────────────────────────── */}
      <path
        d={`M${TRUNK_X} 55 V${lastCentre}`}
        fill="none"
        strokeWidth="1.25"
        className="stroke-line"
      />
      <path
        d={`M${TRUNK_X} 55 V${lastCentre}`}
        fill="none"
        strokeWidth="1.5"
        className="stroke-accent hb-flow"
      />

      {BRANCHES.map((branch, index) => {
        const cy = centreOf(index);
        const tone = branch.tone;
        return (
          <g key={branch.name} className="hb-rise" style={{ animationDelay: `${140 + index * 110}ms` }}>
            <path
              d={`M${TRUNK_X} ${cy} H52`}
              fill="none"
              strokeWidth="1.25"
              className="stroke-line"
            />
            <path
              d={`M${TRUNK_X} ${cy} H52`}
              fill="none"
              strokeWidth="1.5"
              className={cn('hb-flow', tone === 'ok' ? 'stroke-accent' : 'stroke-warn')}
            />

            <rect
              x="52"
              y={ROW_TOPS[index]}
              width="346"
              height={ROW_HEIGHT}
              rx="10"
              className="fill-panel stroke-line"
            />

            {tone === 'ok' ? (
              <>
                <circle cx="72" cy={cy} r="7" fill="none" strokeWidth="1.25" className="stroke-ok/40" />
                <circle cx="72" cy={cy} r="3.25" className="fill-ok" />
              </>
            ) : (
              <>
                <circle cx="72" cy={cy} r="7" fill="none" strokeWidth="1.5" className="stroke-warn/30" />
                <circle
                  cx="72"
                  cy={cy}
                  r="7"
                  fill="none"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                  strokeDasharray="11 33"
                  className="stroke-warn hb-spin"
                />
              </>
            )}

            <text x="90" y={cy - 3} fontSize="12" className="fill-ink font-medium">
              {branch.name}
            </text>
            <text x="90" y={cy + 12} fontSize="9.5" className="fill-ink-subtle font-mono">
              {branch.url}
            </text>
            <text x="286" y={cy - 3} fontSize="9.5" textAnchor="end" className="fill-ink-subtle">
              {branch.attempt}
            </text>

            <rect
              x="296"
              y={cy - 10}
              width="86"
              height="20"
              rx="6"
              className={tone === 'ok' ? 'fill-ok-soft' : 'fill-warn-soft'}
            />
            <text
              x="339"
              y={cy + 4}
              fontSize="10"
              textAnchor="middle"
              className={cn('font-medium', tone === 'ok' ? 'fill-ok' : 'fill-warn')}
            >
              {branch.chip}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** Three properties of the delivery path, each of them documented behaviour. */
const FACTS = [
  'Signed per attempt, HMAC-SHA256',
  'Exponential backoff with jitter',
  'Every attempt kept, and replayable',
];

export function DeliveryShowcase() {
  return (
    <div className="relative flex h-full flex-col justify-center overflow-hidden border-l border-line bg-canvas px-10 py-16 xl:px-16">
      <div aria-hidden="true" className="hb-auth-grid pointer-events-none absolute inset-0" />
      <div aria-hidden="true" className="hb-auth-glow pointer-events-none absolute inset-0" />

      <div className="relative mx-auto w-full max-w-[30rem]">
        <p className="hb-rise text-2xs font-semibold uppercase tracking-[0.16em] text-accent">
          The delivery ledger
        </p>
        <h2 className="hb-rise mt-3 text-[1.75rem] font-semibold leading-[1.15] tracking-tight text-ink xl:text-[2rem]">
          Every webhook you send.
          <br />
          And proof of what happened to it.
        </h2>
        <p
          className="hb-rise mt-4 max-w-[27rem] text-base leading-relaxed text-ink-muted"
          style={{ animationDelay: '80ms' }}
        >
          One event becomes one delivery per subscription — each with its own retry chain, its own
          attempt history, and a signature on every request. So &ldquo;did finance ever receive
          this?&rdquo; has an answer at 2am.
        </p>

        <div
          className="hb-rise mt-9 rounded-2xl border border-line bg-panel p-4 shadow-pop"
          style={{ animationDelay: '120ms' }}
        >
          <FanOutDiagram />
          <div className="mt-3 flex items-center gap-2 overflow-hidden border-t border-line pt-3">
            <span className="text-2xs font-medium uppercase tracking-[0.12em] text-ink-subtle">
              sent
            </span>
            <code className="truncate font-mono text-2xs text-ink-muted">
              Webhook-Signature: t=1757155200,v1=9f2c4b…
            </code>
          </div>
        </div>

        <ul
          className="hb-rise mt-7 flex flex-wrap gap-x-5 gap-y-2 text-xs text-ink-muted"
          style={{ animationDelay: '200ms' }}
        >
          {FACTS.map((fact) => (
            <li key={fact} className="flex items-center gap-1.5">
              <svg viewBox="0 0 12 12" className="h-3 w-3 shrink-0 text-accent" aria-hidden="true">
                <path
                  d="M2.5 6.3 5 8.8l4.5-5.6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              {fact}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
