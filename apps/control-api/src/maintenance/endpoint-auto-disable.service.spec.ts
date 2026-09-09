import { AuditService } from '../authz';
import {
  AUTO_DISABLE_AUDIT_ACTION,
  AUTO_DISABLE_REASON_PREFIX,
} from './auto-disable-policy';
import { AutoDisableOptions, EndpointAutoDisableService } from './endpoint-auto-disable.service';
import { FakeMaintenancePrisma } from './testing/prisma.fake';

const NOW = new Date('2026-09-09T12:00:00.000Z');
const OPTIONS: AutoDisableOptions = { enabled: true, afterHours: 72, maxPerRun: 200 };

function hoursAgo(hours: number): Date {
  return new Date(NOW.getTime() - hours * 3_600_000);
}

interface World {
  db: FakeMaintenancePrisma;
  service: EndpointAutoDisableService;
}

function world(): World {
  const db = new FakeMaintenancePrisma();
  db.seedProject('proj_a', 'org_a');
  return { db, service: new EndpointAutoDisableService(db.asPrisma(), new AuditService(db.asPrisma())) };
}

/** An endpoint whose breaker has been open for `hours`. */
function dark(db: FakeMaintenancePrisma, id: string, hours: number): void {
  db.seedEndpoint({ id, projectId: 'proj_a', url: `https://${id}.example.test/hook` });
  db.seedHealth({
    endpointId: id,
    state: 'open',
    openedAt: hoursAgo(hours),
    consecutiveFailures: 5,
    lastSuccessAt: hoursAgo(hours + 1),
  });
}

describe('EndpointAutoDisableService', () => {
  it('disables an endpoint whose breaker has been open past the window', async () => {
    const { db, service } = world();
    dark(db, 'ep_dead', 100);

    const report = await service.sweep(OPTIONS, NOW);

    expect(report).toMatchObject({ skipped: false, considered: 1, disabled: 1, truncated: false });
    const row = db.endpoints.get('ep_dead');
    expect(row).toMatchObject({ status: 'disabled', enabled: false, disabledAt: NOW });
    expect(row?.disabledReason?.startsWith(AUTO_DISABLE_REASON_PREFIX)).toBe(true);
  });

  it('leaves an endpoint that has not been open long enough alone', async () => {
    const { db, service } = world();
    dark(db, 'ep_flapping', 71);

    const report = await service.sweep(OPTIONS, NOW);

    expect(report.disabled).toBe(0);
    expect(db.endpoints.get('ep_flapping')).toMatchObject({ status: 'active', enabled: true });
  });

  /**
   * The whole reason auto-disable is defensible is that the customer is told.
   * An audit row that does not carry the evidence is a row that generates the
   * support ticket it was supposed to prevent.
   */
  it('files an audit entry against the endpoint`s own organization, with the evidence', async () => {
    const { db, service } = world();
    dark(db, 'ep_dead', 100);

    await service.sweep(OPTIONS, NOW);

    expect(db.auditRows).toHaveLength(1);
    const entry = db.auditRows[0];
    expect(entry.action).toBe(AUTO_DISABLE_AUDIT_ACTION);
    expect(entry.resourceType).toBe('endpoint');
    expect(entry.resourceId).toBe('ep_dead');
    // Derived through endpoint -> project -> organization, never stated.
    expect(entry.organizationId).toBe('org_a');
    // No human did this, and no human's name is on it.
    expect(entry.userId).toBeNull();
    expect(entry.apiKeyId).toBeNull();
    const metadata = entry.metadata as Record<string, unknown>;
    expect(metadata.circuit_open_since).toBe(hoursAgo(100).toISOString());
    expect(metadata.consecutive_failures).toBe(5);
    expect(metadata.previous_status).toBe('active');
    expect(metadata.threshold_hours).toBe(72);
    expect(String(metadata.remedy)).toContain('/enable');
  });

  /**
   * A pass must be idempotent. The second run must find nothing, or every
   * subsequent pass files another audit entry for a disable that happened once.
   */
  it('does not disable, or audit, the same endpoint twice', async () => {
    const { db, service } = world();
    dark(db, 'ep_dead', 100);

    await service.sweep(OPTIONS, NOW);
    const second = await service.sweep(OPTIONS, NOW);

    expect(second).toMatchObject({ considered: 0, disabled: 0 });
    expect(db.auditRows).toHaveLength(1);
  });

  /**
   * The conditional UPDATE is the concurrency story. If an operator pauses or
   * deletes the endpoint between the read and the write, nothing is written and
   * - critically - no audit entry is filed for a disable that did not happen.
   */
  it('writes nothing and audits nothing when the endpoint changed under the pass', async () => {
    const { db, service } = world();
    dark(db, 'ep_racing', 100);
    // What the operator's own DELETE would have left behind.
    db.endpoints.set('ep_racing', {
      ...db.endpoints.get('ep_racing')!,
      status: 'deleted',
      enabled: false,
    });
    // The candidate query already filters this out, so drive `disable` through
    // a health row the query still returns: an endpoint that was active when
    // read and is not by the time it is written.
    const health = db.health.get('ep_racing')!;
    db.endpointHealth.findMany = async (): Promise<unknown[]> => [
      {
        endpointId: health.endpointId,
        openedAt: health.openedAt,
        consecutiveFailures: health.consecutiveFailures,
        lastSuccessAt: health.lastSuccessAt,
        endpoint: {
          name: 'racing',
          url: 'https://racing.example.test/hook',
          status: 'active',
          projectId: 'proj_a',
          project: { organizationId: 'org_a' },
        },
      },
    ];

    const report = await service.sweep(OPTIONS, NOW);

    expect(report).toMatchObject({ considered: 1, disabled: 0 });
    expect(db.auditRows).toHaveLength(0);
    expect(db.endpoints.get('ep_racing')).toMatchObject({ status: 'deleted' });
  });

  /**
   * `paused` is what an operator's own POST /disable produces, and it leaves
   * `disabled_reason` NULL on purpose. The sweep must not overwrite it - doing
   * so would relabel a human's decision as the platform's.
   */
  it('never touches an endpoint an operator has already paused', async () => {
    const { db, service } = world();
    dark(db, 'ep_paused', 100);
    db.endpoints.set('ep_paused', {
      ...db.endpoints.get('ep_paused')!,
      status: 'paused',
      enabled: false,
    });

    const report = await service.sweep(OPTIONS, NOW);

    expect(report.considered).toBe(0);
    expect(db.endpoints.get('ep_paused')).toMatchObject({
      status: 'paused',
      disabledReason: null,
    });
  });

  /**
   * `half_open` means a worker is holding the probe slot right now. An endpoint
   * one second from answering must not be switched off; it returns to `open` if
   * the probe fails and is caught on the next pass.
   */
  it('skips an endpoint that is mid-probe', async () => {
    const { db, service } = world();
    dark(db, 'ep_probing', 100);
    db.health.set('ep_probing', { ...db.health.get('ep_probing')!, state: 'half_open' });

    const report = await service.sweep(OPTIONS, NOW);

    expect(report).toMatchObject({ considered: 0, disabled: 0 });
    expect(db.endpoints.get('ep_probing')).toMatchObject({ status: 'active', enabled: true });
  });

  it('takes the longest-dark endpoints first and stops at the per-run ceiling', async () => {
    const { db, service } = world();
    dark(db, 'ep_newest', 80);
    dark(db, 'ep_oldest', 500);
    dark(db, 'ep_middle', 200);

    const report = await service.sweep({ ...OPTIONS, maxPerRun: 2 }, NOW);

    expect(report).toMatchObject({ considered: 2, disabled: 2, truncated: true });
    expect(db.endpoints.get('ep_oldest')?.enabled).toBe(false);
    expect(db.endpoints.get('ep_middle')?.enabled).toBe(false);
    expect(db.endpoints.get('ep_newest')?.enabled).toBe(true);
  });

  /**
   * Every replica runs the timer. Losing the advisory lock must be a no-op, not
   * a second pass contending on the same rows.
   */
  it('does nothing when another replica holds the advisory lock', async () => {
    const { db, service } = world();
    dark(db, 'ep_dead', 100);
    db.lockAvailable = false;

    const report = await service.sweep(OPTIONS, NOW);

    expect(report.skipped).toBe(true);
    expect(db.endpoints.get('ep_dead')).toMatchObject({ status: 'active', enabled: true });
    expect(db.auditRows).toHaveLength(0);
  });

  it('takes the lock inside ONE transaction for the whole pass', async () => {
    const { db, service } = world();
    dark(db, 'ep_a', 100);
    dark(db, 'ep_b', 200);

    await service.sweep(OPTIONS, NOW);

    expect(db.transactions).toBe(1);
    expect(db.lockAttempts).toBe(1);
  });

  it('does not even open a transaction when disabled', async () => {
    const { db, service } = world();
    dark(db, 'ep_dead', 100);

    const report = await service.sweep({ ...OPTIONS, enabled: false }, NOW);

    expect(report).toMatchObject({ skipped: false, considered: 0, disabled: 0 });
    expect(db.transactions).toBe(0);
    expect(db.endpoints.get('ep_dead')).toMatchObject({ status: 'active', enabled: true });
  });
});
