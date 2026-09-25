import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Badge,
  CodeBlock,
  ErrorState,
  Input,
  PageHeader,
  Panel,
  Skeleton,
} from '../../components';
import { useSetupState } from './api';
import { isSetupComplete, type SetupStep } from './setup';
import { SetupChecklist } from './SetupChecklist';
import {
  API_KEY_PLACEHOLDER,
  buildPublishCurl,
  ingestBaseUrl,
  PUBLISH_EXPECTED_RESPONSE,
} from './publish-request';

/**
 * Signup to first delivered webhook, without reading the docs.
 *
 * The ordering here is the argument: the mental model first (one event routes
 * to N deliveries, each retrying independently), then the checklist, then the
 * exact request to run. Someone who reads only the first panel still
 * understands what the other screens are showing them, which is the thing that
 * makes "event vs delivery vs attempt" stop being confusing.
 */
export function GetStartedPage() {
  const { orgId = '', projectId = '' } = useParams();
  const setup = useSetupState(orgId, projectId);
  const [apiKey, setApiKey] = useState('');

  const base = `/orgs/${orgId}/projects/${projectId}`;
  const hrefFor = (step: SetupStep): string | null => {
    // A step this role may not read is not a link: the page behind it answers a
    // 403, and offering the route is offering a dead end.
    if (step.state === 'unavailable') return null;
    switch (step.id) {
      case 'api-key':
        return `${base}/api-keys`;
      case 'endpoint':
        return `${base}/endpoints`;
      case 'subscription':
        return `${base}/subscriptions`;
      case 'event':
        return step.state === 'done' ? `${base}/events` : null;
      case 'project':
        return `${base}/settings`;
      case 'organization':
        return `/orgs/${orgId}/settings`;
      default:
        return null;
    }
  };

  const complete = !setup.isPending && isSetupComplete(setup.steps);

  return (
    <div className="flex max-w-4xl flex-col gap-5">
      <PageHeader
        title="Get started"
        description="Five things exist between an account and a delivered webhook. This page is all five, in order."
        actions={
          complete ? (
            <Badge tone="ok" dot>
              Setup complete
            </Badge>
          ) : undefined
        }
      />

      <MentalModel />

      <Panel
        title="Setup"
        description="Derived from this project — nothing to tick off by hand."
      >
        {setup.isError ? (
          <ErrorState
            error={new Error('Some of this project could not be read.')}
            title="Setup state is incomplete"
          />
        ) : setup.isPending ? (
          <div className="flex flex-col gap-2" aria-busy="true">
            <span className="sr-only" role="status">
              Checking setup
            </span>
            {Array.from({ length: 6 }, (_, index) => (
              <Skeleton key={index} className="h-14" />
            ))}
          </div>
        ) : (
          <SetupChecklist steps={setup.steps} hrefFor={hrefFor} />
        )}
      </Panel>

      <Panel
        title="Publish a test event"
        description="Ready to run. The project id is already yours."
      >
        <div className="flex flex-col gap-3">
          <Input
            label="Your API key (optional)"
            hint="Pasted into the request below so you can copy the whole thing. It stays in this tab — never sent anywhere, never stored, never cached."
            mono
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={API_KEY_PLACEHOLDER}
            spellCheck={false}
            autoComplete="off"
          />

          <CodeBlock
            value={buildPublishCurl({ projectId, apiKey })}
            language="text"
            label="publish an event"
            showSize={false}
            maxHeight="20rem"
          />

          <div className="rounded-md border border-line bg-raised/50 px-3 py-2.5">
            <p className="text-2xs font-medium uppercase tracking-wider text-ink-subtle">
              What success looks like
            </p>
            <pre className="mt-1.5 whitespace-pre-wrap font-mono text-2xs leading-relaxed text-ink-muted">
              {PUBLISH_EXPECTED_RESPONSE}
            </pre>
            <p className="mt-2 text-xs leading-relaxed text-ink-muted">
              <strong className="font-semibold text-ink">
                &quot;Accepted&quot; means stored, not delivered.
              </strong>{' '}
              The response returns as soon as the event is durably written; routing happens after
              that. Watch it land on{' '}
              <Link
                to={`/orgs/${orgId}/projects/${projectId}/events`}
                className="text-accent hover:underline"
              >
                Events
              </Link>
              , then follow it into{' '}
              <Link
                to={`/orgs/${orgId}/projects/${projectId}/deliveries`}
                className="text-accent hover:underline"
              >
                Deliveries
              </Link>{' '}
              to see the per-endpoint attempt chain.
            </p>
          </div>

          <p className="text-2xs leading-relaxed text-ink-subtle">
            Ingest is a separate service from this dashboard&rsquo;s control API and lives at{' '}
            <code className="font-mono text-ink-muted">{ingestBaseUrl()}</code>. Set{' '}
            <code className="font-mono text-ink-muted">VITE_INGEST_BASE_URL</code> at build time if
            yours is elsewhere.
          </p>
        </div>
      </Panel>

      <Panel title="Before you go live">
        <ul className="flex flex-col gap-2 text-xs leading-relaxed text-ink-muted">
          <Tip title="Verify the signature.">
            Every delivery carries <code className="font-mono">Webhook-Signature</code>. Compute{' '}
            <code className="font-mono">HMAC-SHA256(secret, &quot;&lt;t&gt;.&lt;raw body&gt;&quot;)</code>{' '}
            over the exact bytes you received — re-serialising the JSON first will not match.
          </Tip>
          <Tip title="Deduplicate on Webhook-Id.">
            Delivery is at-least-once by design, so retries mean duplicates. A consumer that is not
            idempotent will double-post the same settlement.
          </Tip>
          <Tip title="Answer 2xx fast, work asynchronously.">
            <code className="font-mono">408</code>, <code className="font-mono">429</code> and{' '}
            <code className="font-mono">5xx</code> are retried with backoff. Every other{' '}
            <code className="font-mono">4xx</code> is treated as permanent and is never retried.
          </Tip>
        </ul>
      </Panel>
    </div>
  );
}

function Tip({ title, children }: { title: string; children: ReactNode }) {
  return (
    <li className="flex gap-2">
      <span aria-hidden="true" className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-ink-subtle" />
      <span>
        <strong className="font-semibold text-ink">{title}</strong> {children}
      </span>
    </li>
  );
}

/**
 * The relationship the rest of the product assumes you already know.
 *
 * Event vs delivery vs attempt is genuinely confusing on first contact, and
 * getting it wrong makes every other screen unreadable — "why are there three
 * rows for the event I published once?" is the question this diagram exists to
 * answer before it is asked.
 */
function MentalModel() {
  return (
    <Panel title="How one event becomes many deliveries">
      <div className="flex flex-col gap-3">
        <ol className="grid gap-2 sm:grid-cols-3">
          <ModelNode
            step="1"
            term="Event"
            gloss="You publish this once."
            detail="A fact from your system: payment.settled, with its payload."
            tone="accent"
          />
          <ModelNode
            step="2"
            term="Delivery"
            gloss="One per matching subscription."
            detail="Created up front, before anything is sent, so it is the record of what SHOULD arrive. Each has its own retry chain."
            tone="info"
          />
          <ModelNode
            step="3"
            term="Attempt"
            gloss="One HTTP request."
            detail="Status code, duration, response body. A delivery that retries eight times has eight of these."
            tone="neutral"
          />
        </ol>
        <p className="text-xs leading-relaxed text-ink-muted">
          Because deliveries are materialised one row per endpoint, &quot;did finance ever receive
          this?&quot; is answerable — and one endpoint can be replayed on its own without touching
          the others.
        </p>
      </div>
    </Panel>
  );
}

function ModelNode({
  step,
  term,
  gloss,
  detail,
  tone,
}: {
  step: string;
  term: string;
  gloss: string;
  detail: string;
  tone: 'accent' | 'info' | 'neutral';
}) {
  const ring =
    tone === 'accent'
      ? 'border-accent/40 bg-accent-soft/40'
      : tone === 'info'
        ? 'border-info/30 bg-info-soft/40'
        : 'border-line bg-raised/50';

  return (
    <li className={`relative rounded-lg border px-3 py-2.5 ${ring}`}>
      <div className="flex items-baseline gap-1.5">
        <span className="text-2xs tabular text-ink-subtle">{step}</span>
        <span className="text-xs font-semibold text-ink">{term}</span>
      </div>
      <p className="mt-0.5 text-2xs font-medium text-ink-muted">{gloss}</p>
      <p className="mt-1 text-2xs leading-relaxed text-ink-subtle">{detail}</p>
    </li>
  );
}
