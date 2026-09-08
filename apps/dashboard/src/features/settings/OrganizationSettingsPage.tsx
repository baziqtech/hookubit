import { Link, useParams } from 'react-router-dom';
import { Async, Badge, PageHeader, Panel } from '../../components';
import { formatTimestamp } from '../../lib/format';
import {
  ORGANIZATION_NAME_MAX_LENGTH,
  ORGANIZATION_NAME_MIN_LENGTH,
  ORGANIZATION_SLUG_MAX_LENGTH,
} from '../../types/api';
import { useOrganization, useUpdateOrganization } from '../organizations/api';
import { IdentityForm } from './IdentityForm';
import { ReadOnly } from './ReadOnly';

/**
 * Organization settings.
 *
 * `UpdateOrganizationDto` is name and slug. `status` is absent deliberately —
 * suspension is a platform and billing decision, and a writable status would
 * let a customer un-suspend their own unpaid organization — and deletion has
 * its own owner-gated, audited route. Both are shown as facts with the reason,
 * not as controls that would fail.
 *
 * A rename has to reach the sidebar. `useUpdateOrganization` invalidates the
 * organizations LIST and the session as well as the row, because the switcher
 * and the breadcrumb read the list: dropping only the row leaves the old name
 * on screen, which reads as the save having silently failed.
 */
export function OrganizationSettingsPage() {
  const { orgId = '' } = useParams();
  const organization = useOrganization(orgId);
  const update = useUpdateOrganization(orgId);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Organization settings"
        description="The billing and people boundary that every project sits inside."
      />

      <Async query={organization}>
        {(data) => (
          <>
            <Panel title="Organization">
              <IdentityForm
                values={{ name: data.name, slug: data.slug }}
                nameLabel="Name"
                nameMin={ORGANIZATION_NAME_MIN_LENGTH}
                nameMax={ORGANIZATION_NAME_MAX_LENGTH}
                slugMax={ORGANIZATION_SLUG_MAX_LENGTH}
                slugHint="Unique across the platform — a collision answers 409. Lowercase letters and digits joined by single hyphens."
                mutation={update}
              />
              <p className="mt-3 text-2xs leading-relaxed text-ink-subtle">
                Renaming updates the switcher and the breadcrumb immediately. It does not change
                the organization ID, and nothing addressed by ID — API keys, endpoints, the
                delivery ledger — is affected.
              </p>
            </Panel>

            <Panel title="Fixed" description="Not editable from here, and why.">
              <dl className="flex flex-col">
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
                <ReadOnly label="Last updated" value={formatTimestamp(data.updated_at)} />
              </dl>

              <p className="mt-3 rounded-md border border-line bg-raised/50 px-3 py-2 text-2xs leading-relaxed text-ink-muted">
                <strong className="font-semibold text-ink">Status is not self-service.</strong>{' '}
                Suspension is a platform and billing decision; a writable status would let an
                organization lift its own suspension. Deleting has its own owner-gated route and is
                audited as a deletion rather than as an edit — there is no button for it here yet.
              </p>
            </Panel>
          </>
        )}
      </Async>

      <Panel title="Not built yet" description="Reserved, with no route behind them.">
        <ul className="flex flex-col gap-1.5 text-xs text-ink-muted">
          {[
            'Default settings applied to new projects',
            'SSO configuration (OIDC / SAML)',
            'Delete the organization',
          ].map((item) => (
            <li key={item} className="flex gap-2">
              <span
                aria-hidden="true"
                className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-ink-subtle"
              />
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
