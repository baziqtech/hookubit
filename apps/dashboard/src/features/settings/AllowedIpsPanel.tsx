import { useEffect, useState } from 'react';
import { Badge, Button, GatedButton, Input, Panel, WriteErrorNotice } from '../../components';
import { cn } from '../../lib/cn';
import type { RoleGate } from '../../lib/role-gate';
import type { Project } from '../../types/api';
import { useUpdateProject } from '../projects/api';

/**
 * Which addresses may PUBLISH events to this project.
 *
 * ## The empty list is not "off", it is "everyone"
 *
 * That is the default and it is fine — until a key leaks. After that the key is
 * the only thing between somebody else and your consumers. The panel says this
 * in its empty state rather than presenting an empty table as a configured
 * state, because "no addresses listed" and "no addresses permitted" read the
 * same and mean opposite things.
 *
 * ## The first entry is the dangerous one
 *
 * Adding one address starts the list, and from that moment EVERY other address
 * is refused — including, very often, the operator's own second service. So the
 * warning about that is attached to the act of adding the first one and
 * disappears afterwards, rather than sitting on the panel permanently where it
 * would be read past.
 *
 * ## Publishing only
 *
 * Stated on the panel because it is the fear that stops people using the
 * feature at all. It is never consulted for reading the record or for signing
 * in, so nobody can lock themselves out of the dashboard with it.
 */
export function AllowedIpsPanel({
  orgId,
  project,
  gate,
}: {
  orgId: string;
  project: Project;
  gate: RoleGate;
}) {
  const update = useUpdateProject(orgId, project.id);
  const [entries, setEntries] = useState<string[]>(project.allowed_ips);
  const [draft, setDraft] = useState('');

  // Re-sync when the server's copy changes under us — a save, or another
  // operator editing the same project in another tab.
  useEffect(() => setEntries(project.allowed_ips), [project.allowed_ips]);

  const enforcing = project.allowed_ips.length > 0;
  const dirty =
    entries.length !== project.allowed_ips.length ||
    entries.some((entry, index) => entry !== project.allowed_ips[index]);
  const startingTheList = !enforcing && entries.length > 0;

  const add = () => {
    const entry = draft.trim();
    if (entry === '' || entries.includes(entry)) {
      setDraft('');
      return;
    }
    setEntries([...entries, entry]);
    setDraft('');
  };

  return (
    <Panel
      title="Allowed IP addresses"
      description="Which addresses may publish events to this project."
      actions={
        enforcing ? (
          <Badge tone="ok" dot>
            {project.allowed_ips.length} {project.allowed_ips.length === 1 ? 'address' : 'addresses'}
          </Badge>
        ) : (
          <Badge tone="neutral">any address</Badge>
        )
      }
    >
      <div className="flex flex-col gap-3">
        {!enforcing && entries.length === 0 && (
          <p className="rounded-[0.625rem] border border-line bg-raised/50 px-3 py-2.5 text-xs leading-relaxed text-ink-muted">
            <strong className="font-semibold text-ink">
              Every IP address can send events to {project.name}.
            </strong>{' '}
            The list is empty, so any request carrying a valid API key for this project is
            accepted, wherever it comes from. That is the default and it is fine — until a key
            leaks. After that, the key is the only thing standing between someone else and your
            consumers.
          </p>
        )}

        {entries.length > 0 && (
          <ul className="flex flex-col gap-1">
            {entries.map((entry) => (
              <li
                key={entry}
                className="flex items-center gap-2 rounded-md border border-line bg-raised/40 px-2.5 py-1.5"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink">{entry}</span>
                <button
                  type="button"
                  onClick={() => setEntries(entries.filter((row) => row !== entry))}
                  className="text-2xs font-medium text-ink-muted transition-colors hover:text-danger"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-end gap-2">
          <Input
            label="Add an address or block"
            value={draft}
            placeholder="203.0.113.0/24"
            hint="An IPv4 or IPv6 address, or a CIDR block. A malformed entry is refused when you save, never silently dropped."
            className="flex-1"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              add();
            }}
          />
          <Button onClick={add} className="mb-[1.375rem]">
            Add
          </Button>
        </div>

        {startingTheList && (
          <p className="rounded-[0.625rem] border border-warn/30 bg-warn-soft px-3 py-2.5 text-xs leading-relaxed text-warn">
            <strong className="font-semibold">This starts the list.</strong> From the moment you
            save, every address that is not on it is refused. Add all of them before you save, or
            your own service will be the first thing turned away.
          </p>
        )}

        <p className="text-2xs leading-relaxed text-ink-subtle">
          The list is checked before the API key, so a refused address never finds out whether the
          key it presented was valid. It applies to <strong>publishing only</strong> — reading the
          delivery record and signing in are unaffected, so nobody can lock themselves out of the
          dashboard with it.
        </p>

        <WriteErrorNotice error={update.error} />

        <div className={cn('flex items-center gap-2', !dirty && 'opacity-60')}>
          <GatedButton
            variant="primary"
            gate={gate}
            action="Changing the allowed addresses"
            disabled={!dirty}
            loading={update.isPending}
            onClick={() => update.mutate({ allowed_ips: entries })}
          >
            Save addresses
          </GatedButton>
          {dirty && (
            <Button onClick={() => setEntries(project.allowed_ips)} disabled={update.isPending}>
              Discard
            </Button>
          )}
        </div>
      </div>
    </Panel>
  );
}
