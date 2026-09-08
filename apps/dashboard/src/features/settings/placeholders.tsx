import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Async,
  Badge,
  EmptyState,
  PageHeader,
  Panel,
  Placeholder,
} from '../../components';
import { formatTimestamp } from '../../lib/format';
import { useOrganization } from '../organizations/api';
import { useProject } from '../projects/api';

/**
 * Routes whose feature is only partly built.
 *
 * The rule applied here: SHOW WHAT THE API ACTUALLY RETURNS, and be explicit
 * about what it does not. Both of these resources have a working `GET` and no
 * `PATCH`, so a settings page that renders nothing is throwing away real
 * information, while one with editable-looking fields is a lie. Read-only
 * values plus a named, specific gap is the honest middle.
 *
 * Billing has no endpoint at all, so it stays a stub — but one that points at
 * Usage, which does have data.
 */

/** A value the API returns and no route can change yet. */
function ReadOnly({
  label,
  value,
  mono,
  badge,
}: {
  label: string;
  value: string;
  mono?: boolean;
  badge?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line py-2 last:border-0">
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className={`flex items-center gap-2 text-xs text-ink ${mono ? 'font-mono' : ''}`}>
        {value}
        {badge}
      </dd>
    </div>
  );
}

/**
 * The gap, named. "Coming soon" tells an operator nothing; naming the missing
 * route tells them whether to wait or to go and use the API.
 */
function NotEditable({ what, route }: { what: string; route: string }) {
  return (
    <p className="mt-3 rounded-md border border-line bg-raised/50 px-3 py-2 text-2xs leading-relaxed text-ink-muted">
      <strong className="font-semibold text-ink">Read-only.</strong> {what} cannot be changed from
      the dashboard yet — the control API has no <code className="font-mono">{route}</code> route.
      Nothing on this page is editable, rather than appearing editable and failing on save.
    </p>
  );
}

export function ProjectSettingsPage() {
  const { orgId = '', projectId = '' } = useParams();
  const project = useProject(projectId);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Project settings"
        description="What this project is, and what is not configurable from here yet."
      />

      <Async query={project}>
        {(data) => (
          <Panel title="Project">
            <dl className="flex flex-col">
              <ReadOnly label="Name" value={data.name} />
              <ReadOnly label="Slug" value={data.slug} mono />
              <ReadOnly label="Project ID" value={data.id} mono />
              <ReadOnly
                label="Environment"
                value={data.environment}
                badge={
                  <Badge tone={data.environment === 'live' ? 'ok' : 'neutral'}>
                    immutable
                  </Badge>
                }
              />
              <ReadOnly
                label="Status"
                value={data.status}
                badge={
                  <Badge tone={data.status === 'active' ? 'ok' : 'danger'} dot>
                    {data.status}
                  </Badge>
                }
              />
              <ReadOnly label="Created" value={formatTimestamp(data.created_at)} />
              <ReadOnly label="Last updated" value={formatTimestamp(data.updated_at)} />
            </dl>

            <p className="mt-3 rounded-md border border-warn/30 bg-warn-soft/50 px-3 py-2 text-2xs leading-relaxed text-warn">
              <strong className="font-semibold">Environment cannot be changed.</strong> It scopes
              every API key and endpoint underneath the project, so switching it would silently
              re-point live traffic. Create a second project instead.
            </p>

            <NotEditable what="Name and slug" route="PATCH /v1/projects/:id" />
          </Panel>
        )}
      </Async>

      <Panel title="Not built yet" description="Reserved, with no route behind them.">
        <ul className="flex flex-col gap-1.5 text-xs text-ink-muted">
          {[
            'Retry policy — max attempts, backoff strategy, jitter',
            'Project-wide rate limit and per-endpoint overrides',
            'Payload retention window',
            'Transfer to another organization, and delete',
          ].map((item) => (
            <li key={item} className="flex gap-2">
              <span aria-hidden="true" className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-ink-subtle" />
              {item}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-2xs text-ink-subtle">
          Per-endpoint timeout, rate limit and concurrency ARE configurable today — on{' '}
          <Link
            to={`/orgs/${orgId}/projects/${projectId}/endpoints`}
            className="text-accent hover:underline"
          >
            Endpoints
          </Link>
          .
        </p>
      </Panel>
    </div>
  );
}

export function OrganizationSettingsPage() {
  const { orgId = '' } = useParams();
  const organization = useOrganization(orgId);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Organization settings"
        description="The billing and people boundary that every project sits inside."
      />

      <Async query={organization}>
        {(data) => (
          <Panel title="Organization">
            <dl className="flex flex-col">
              <ReadOnly label="Name" value={data.name} />
              <ReadOnly label="Slug" value={data.slug} mono />
              <ReadOnly label="Organization ID" value={data.id} mono />
              <ReadOnly
                label="Status"
                value={data.status}
                badge={
                  <Badge tone={data.status === 'active' ? 'ok' : 'danger'} dot>
                    {data.status}
                  </Badge>
                }
              />
              <ReadOnly
                label="Your role"
                value={data.role}
                badge={<Badge tone="neutral">{data.role}</Badge>}
              />
              <ReadOnly label="Created" value={formatTimestamp(data.created_at)} />
            </dl>

            <NotEditable what="Name and slug" route="PATCH /v1/organizations/:id" />
          </Panel>
        )}
      </Async>

      <Panel title="Not built yet" description="Reserved, with no route behind them.">
        <ul className="flex flex-col gap-1.5 text-xs text-ink-muted">
          {[
            'Rename the organization and change its slug',
            'Default settings applied to new projects',
            'SSO configuration (OIDC / SAML)',
            'Delete the organization',
          ].map((item) => (
            <li key={item} className="flex gap-2">
              <span aria-hidden="true" className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-ink-subtle" />
              {item}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-2xs text-ink-subtle">
          Members and roles are managed today on{' '}
          <Link to={`/orgs/${orgId}/team`} className="text-accent hover:underline">
            Team
          </Link>
          .
        </p>
      </Panel>
    </div>
  );
}

/**
 * Billing genuinely has no backend — no route, no shape, not even in the mock.
 * So it stays an honest empty state rather than a fabricated invoice table, and
 * it sends the operator to Usage, which has real numbers.
 */
export function BillingPage() {
  const { orgId = '' } = useParams();

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Billing" description="Plan, payment method and invoices." />

      <Panel>
        <EmptyState
          title="Billing is not built yet"
          description={
            <>
              <p className="mb-2">
                There is no billing route on the control API — not a stub, not a shape. Nothing on
                this page is real, so nothing is shown.
              </p>
              <p>
                Metered volume for the current period is already available on{' '}
                <Link to={`/orgs/${orgId}/usage`} className="text-accent hover:underline">
                  Usage
                </Link>
                , which is what an invoice would be calculated from.
              </p>
            </>
          }
        />
      </Panel>

      <Placeholder
        title="Billing"
        planned={[
          'Current plan and included event volume',
          'Payment method',
          'Invoice history and downloadable receipts',
          'Overage alerts before the period closes',
        ]}
      />
    </div>
  );
}
