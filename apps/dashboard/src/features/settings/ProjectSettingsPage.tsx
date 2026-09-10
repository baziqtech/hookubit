import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Async, Badge, PageHeader, Panel } from '../../components';
import { formatTimestamp } from '../../lib/format';
import {
  PROJECT_NAME_MAX_LENGTH,
  PROJECT_NAME_MIN_LENGTH,
  PROJECT_SLUG_MAX_LENGTH,
} from '../../types/api';
import { useOrganizations } from '../organizations/api';
import { useDeleteProject, useProject, useUpdateProject } from '../projects/api';
import { projectWriteGate } from '../projects/permissions';
import { DangerZonePanel, TypeToConfirmDialog } from './DangerZone';
import { IdentityForm } from './IdentityForm';
import { ReadOnly } from './ReadOnly';

/**
 * Project settings — editable where the API is, read-only where it is not, and
 * explicit about which is which.
 *
 * `UpdateProjectDto` accepts `name` and `slug`. It accepts NOTHING else, and
 * the two absences are the interesting part:
 *
 *   - `environment` is immutable, and its absence from the DTO is the
 *     enforcement: `forbidNonWhitelisted` refuses a body carrying it before the
 *     DTO is reached, and `ProjectsService.update` checks the key again so a
 *     caller arriving without the pipe gets a refusal that explains why. It is
 *     shown here as a value with the reason attached, never as a disabled
 *     input — a greyed-out dropdown reads as "ask an admin", when the truth is
 *     "make a second project".
 *   - `status` is absent because a soft delete is `DELETE`, audited as
 *     `project.deleted`. A status slipped through a PATCH would be audited as
 *     an edit.
 */
export function ProjectSettingsPage() {
  const { orgId = '', projectId = '' } = useParams();
  const project = useProject(orgId, projectId);
  const update = useUpdateProject(orgId, projectId);
  const remove = useDeleteProject(orgId, projectId);
  const navigate = useNavigate();
  const organizations = useOrganizations();
  const gate = projectWriteGate(
    organizations.data?.rows.find((organization) => organization.id === orgId),
  );
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Project settings"
        description="What this project is called, and what about it cannot be changed."
      />

      <Async query={project}>
        {(data) => (
          <>
            <Panel title="Project">
              <IdentityForm
                values={{ name: data.name, slug: data.slug }}
                nameLabel="Name"
                nameMin={PROJECT_NAME_MIN_LENGTH}
                nameMax={PROJECT_NAME_MAX_LENGTH}
                slugMax={PROJECT_SLUG_MAX_LENGTH}
                slugHint="Unique within this organization — a collision answers 409. Lowercase letters and digits joined by single hyphens."
                mutation={update}
              />
            </Panel>

            <Panel title="Fixed" description="Set when the project was created, and not editable.">
              <dl className="flex flex-col">
                <ReadOnly label="Project ID" value={data.id} mono />
                <ReadOnly
                  label="Environment"
                  value={data.environment}
                  badge={
                    <Badge tone={data.environment === 'live' ? 'ok' : 'neutral'}>immutable</Badge>
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
                <strong className="font-semibold">Environment cannot be changed</strong>, and the
                API refuses it with a reason rather than ignoring it. It scopes every API key and
                endpoint underneath this project, so switching it would silently re-point live
                traffic. Create a second project instead.
              </p>
              <p className="mt-2 rounded-md border border-line bg-raised/50 px-3 py-2 text-2xs leading-relaxed text-ink-muted">
                <strong className="font-semibold text-ink">Deleting is a separate route.</strong>{' '}
                It is a soft delete — the project and its delivery ledger survive — and it is
                audited as a deletion rather than as an edit, which is why it is not a status you
                can save from this form. The button is in the Danger zone at the foot of this page.
              </p>
            </Panel>
          </>
        )}
      </Async>

      <Panel
        title="Policies"
        description="Retry policies and rate limits are project configuration with their own page."
      >
        <p className="text-xs leading-relaxed text-ink-muted">
          How this project’s deliveries are retried — backoff strategy, attempts, delays, jitter, the
          wall-clock budget, and which policy is the default — and the ceilings on how fast its
          events are accepted, are on{' '}
          <Link
            to={`/orgs/${orgId}/projects/${projectId}/policies`}
            className="text-accent hover:underline"
          >
            Policies
          </Link>
          . Per-endpoint timeout, rate limit, concurrency and custom headers stay on{' '}
          <Link
            to={`/orgs/${orgId}/projects/${projectId}/endpoints`}
            className="text-accent hover:underline"
          >
            Endpoints
          </Link>
          .
        </p>
        <p className="mt-3 text-2xs font-medium uppercase tracking-wider text-ink-subtle">
          Not built yet
        </p>
        <ul className="mt-1.5 flex flex-col gap-1.5 text-xs text-ink-muted">
          {[
            // No route exists for either of these; they are listed so the
            // absence is stated rather than discovered.
            'Payload retention window',
            'Transfer to another organization',
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
      </Panel>

      <Async query={project}>
        {(data) => (
          <>
            <DangerZonePanel
              title="Delete this project"
              description={
                <>
                  A soft delete, audited as <code className="font-mono">project.deleted</code>. The
                  project disappears from the dashboard and the API, its keys stop working at
                  ingest, and its delivery ledger is kept forever. There is no undelete.
                </>
              }
              gate={gate}
              action="Deleting a project"
              buttonLabel="Delete project"
              onClick={() => setConfirmingDelete(true)}
            />
            {confirmingDelete && (
              <TypeToConfirmDialog
                title="Delete this project?"
                subject={`${data.name} · ${data.environment}`}
                slug={data.slug}
                confirmLabel="Delete project"
                mutation={remove}
                onSuccess={() => {
                  setConfirmingDelete(false);
                  navigate(`/orgs/${orgId}`);
                }}
                onClose={() => setConfirmingDelete(false)}
              >
                <p>
                  <strong className="text-ink">Nothing is erased.</strong> The project’s status
                  becomes <code className="font-mono">deleted</code>; endpoints, API keys and every
                  delivery and attempt stay exactly where they are, so “did finance ever receive
                  this?” can still be answered months from now.
                </p>
                <ul className="list-disc pl-4">
                  <li>
                    <strong className="text-ink">API keys are refused</strong>, not revoked. The
                    ingest path rejects every key whose project is not active, so publishing stops
                    immediately — and nothing has to be undone by hand if this was a mistake.
                  </li>
                  <li>No new events are accepted, so no new deliveries are created.</li>
                  <li>
                    The project vanishes from every list and route here; the API still lists it with{' '}
                    <code className="font-mono">?status=deleted</code>.
                  </li>
                  <li>
                    The slug <code className="font-mono">{data.slug}</code> stays taken in this
                    organization.
                  </li>
                  <li>There is no undelete, in the dashboard or the API.</li>
                </ul>
              </TypeToConfirmDialog>
            )}
          </>
        )}
      </Async>
    </div>
  );
}
