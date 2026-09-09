import { IDS } from '../authz/testing/fixtures';
import { Harness, harnessFor } from '../endpoint-secrets/testing/harness';

/**
 * The way back from an automatic disable.
 *
 * Auto-disable (`src/maintenance`) is only defensible because a customer can
 * undo it through the ordinary `endpoints.write` route, and because undoing it
 * does not release a backlog at an endpoint whose recovery is still only an
 * assertion. Both halves are asserted here.
 */
async function scope(): Promise<Harness> {
  return harnessFor(IDS.ownerA, { orgId: IDS.orgA, projectId: IDS.projectA1 });
}

/** The state the auto-disable sweep leaves an endpoint in. */
function autoDisable(h: Harness, endpointId: string): void {
  const row = h.db.rows('endpoint').get(endpointId);
  h.db.rows('endpoint').set(endpointId, {
    ...row,
    status: 'disabled',
    enabled: false,
    disabledReason: 'auto-disabled: the circuit breaker had been open for 4d',
    disabledAt: new Date('2026-09-05T00:00:00.000Z'),
  });
}

/**
 * `seedWorld` already seeds one `endpoint_health` row per endpoint - the table
 * is keyed by `endpoint_id` and has at most one - so these helpers MUTATE that
 * row rather than inserting a second one. A fixture with two health rows for one
 * endpoint is a state the schema cannot hold, and an assertion read off the
 * wrong one of them would be meaningless.
 */
function setHealth(h: Harness, endpointId: string, patch: Record<string, unknown>): void {
  const rows = h.db.rows('endpointHealth');
  for (const [id, row] of rows) {
    if (row.endpointId === endpointId) rows.set(id, { ...row, ...patch });
  }
}

/** A tripped breaker whose next probe is a cooldown away. */
function trippedBreaker(h: Harness, endpointId: string, state = 'open'): void {
  setHealth(h, endpointId, {
    state,
    consecutiveFailures: 40,
    consecutiveSuccesses: 0,
    openedAt: new Date('2026-09-05T00:00:00.000Z'),
    probeAfter: new Date('2099-01-01T00:00:00.000Z'),
  });
}

function health(h: Harness, endpointId: string): Record<string, unknown> {
  return h.db
    .all('endpointHealth')
    .find((row) => row.endpointId === endpointId) as Record<string, unknown>;
}

describe('re-enabling an auto-disabled endpoint', () => {
  it('clears the automatic reason, so the next reader does not think it is still tripped', async () => {
    const h = await scope();
    autoDisable(h, IDS.endpointA1);

    const dto = await h.endpoints.enable(h.context, IDS.endpointA1);

    expect(dto).toMatchObject({ status: 'active', enabled: true, disabled_reason: null, disabled_at: null });
  });

  /**
   * Without this the customer presses Resume, nothing happens for up to ten
   * minutes - the breaker's cooldown ceiling - and every new delivery is
   * claimed, refused and deferred in the meantime.
   */
  it('brings the breaker`s next probe forward to now', async () => {
    const h = await scope();
    autoDisable(h, IDS.endpointA1);
    trippedBreaker(h, IDS.endpointA1);
    const before = Date.now();

    await h.endpoints.enable(h.context, IDS.endpointA1);

    const probeAfter = health(h, IDS.endpointA1).probeAfter as Date;
    expect(probeAfter.getTime()).toBeGreaterThanOrEqual(before);
    expect(probeAfter.getTime()).toBeLessThanOrEqual(Date.now());
  });

  /**
   * THE THUNDERING HERD. Resetting the health row to `healthy` would admit
   * every queued delivery at once, at an endpoint whose recovery is still only
   * the customer's assertion. One column moves; the state machine and its
   * counters are the data plane's and stay exactly as they were, so the
   * existing half-open protocol still lets exactly ONE delivery through until
   * the endpoint answers.
   */
  it('moves one column and does not reset the breaker`s state or its counters', async () => {
    const h = await scope();
    autoDisable(h, IDS.endpointA1);
    trippedBreaker(h, IDS.endpointA1);

    await h.endpoints.enable(h.context, IDS.endpointA1);

    expect(health(h, IDS.endpointA1)).toMatchObject({
      state: 'open',
      consecutiveFailures: 40,
      consecutiveSuccesses: 0,
      openedAt: new Date('2026-09-05T00:00:00.000Z'),
    });
  });

  it('arms the probe for an endpoint that is mid-probe too', async () => {
    const h = await scope();
    trippedBreaker(h, IDS.endpointA1, 'half_open');

    await h.endpoints.enable(h.context, IDS.endpointA1);

    const probeAfter = health(h, IDS.endpointA1).probeAfter as Date;
    expect(probeAfter.getTime()).toBeLessThanOrEqual(Date.now());
  });

  /**
   * A healthy or degraded breaker is already admitting traffic and has no probe
   * to bring forward. Writing one anyway would be a pointless update on a row
   * the data plane owns.
   */
  it('leaves a breaker that is not tripped alone', async () => {
    const h = await scope();
    setHealth(h, IDS.endpointA1, {
      state: 'degraded',
      consecutiveFailures: 2,
      consecutiveSuccesses: 0,
      openedAt: null,
      probeAfter: null,
    });

    await h.endpoints.enable(h.context, IDS.endpointA1);

    expect(health(h, IDS.endpointA1)).toMatchObject({ state: 'degraded', probeAfter: null });
  });

  /**
   * An endpoint that was auto-disabled and re-enabled would otherwise leave no
   * trace of the first half anywhere a customer can read: `disabled_reason` is
   * cleared by this very call.
   */
  it('records what it cleared, and whether the breaker was still tripped', async () => {
    const h = await scope();
    autoDisable(h, IDS.endpointA1);
    trippedBreaker(h, IDS.endpointA1);

    await h.endpoints.enable(h.context, IDS.endpointA1);

    const entry = h.db.all('auditLog').find((row) => row.action === 'endpoint.enabled');
    expect(entry).toBeDefined();
    const metadata = entry?.metadata as Record<string, unknown>;
    expect(metadata.previous_status).toBe('disabled');
    expect(String(metadata.previous_disabled_reason)).toContain('auto-disabled');
    expect(metadata.breaker_probe_armed).toBe(true);
  });

  it('says the probe was not armed when there was nothing to arm', async () => {
    const h = await scope();

    await h.endpoints.enable(h.context, IDS.endpointA1);

    const entry = h.db.all('auditLog').find((row) => row.action === 'endpoint.enabled');
    expect((entry?.metadata as Record<string, unknown>).breaker_probe_armed).toBe(false);
  });

  /**
   * The tenant predicate is on the health write too. `endpoint_health` is
   * reached through `endpoint -> project`, so a probe belonging to another
   * tenant must be untouched even though this call names only an endpoint id
   * that this tenant does own.
   */
  it('does not arm another tenant`s probe', async () => {
    const h = await scope();
    trippedBreaker(h, IDS.endpointA1);
    trippedBreaker(h, IDS.endpointB1);

    await h.endpoints.enable(h.context, IDS.endpointA1);

    expect(health(h, IDS.endpointB1).probeAfter).toEqual(new Date('2099-01-01T00:00:00.000Z'));
  });
});
