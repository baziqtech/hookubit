import { beforeEach, describe, expect, it } from 'vitest';
import type {
  Endpoint,
  NotificationDestination,
  Organization,
  Project,
  Subscription,
} from '../../types/api';
import * as db from './data';
import { MockHttpError, mockRequest, resetMockState } from './server';

/**
 * The four write routes that already existed on the control API and were never
 * wired: `PATCH` on an endpoint, `enable`, `disable`, and `PATCH` on a project
 * and an organization.
 *
 * The mock IS the contract until `generate:api` runs, so the FAILURES matter at
 * least as much as the happy paths. Every one of these is a branch the
 * dashboard renders differently, and a mock that only implemented the 200 would
 * leave all of them first exercised in production.
 */
const ORG = 'org_01JQSHAQ';
const PROJECT = 'proj_01JQPAYPROD';
/** The endpoint the circuit breaker disabled: `enabled: true, status: disabled`. */
const BROKEN = 'ep_01JQPARTNER';
/** Created by a developer, so it has no signing secret and cannot be enabled. */
const NO_SECRET = 'ep_01JQPENDING';
const DELETED = 'ep_01JQREMOVED';

beforeEach(() => resetMockState());

const patchEndpoint = (id: string, body: Record<string, unknown>) =>
  mockRequest<Endpoint>('PATCH', `/v1/projects/${PROJECT}/endpoints/${id}`, body);

async function failure(request: Promise<unknown>): Promise<MockHttpError> {
  try {
    await request;
  } catch (error) {
    if (error instanceof MockHttpError) return error;
    throw error;
  }
  throw new Error('expected the request to be refused');
}

describe('endpoints are nested under the project', () => {
  it('serves one endpoint at the path the controller is actually mounted on', async () => {
    const endpoint = await mockRequest<Endpoint>(
      'GET',
      `/v1/projects/${PROJECT}/endpoints/${BROKEN}`,
    );
    expect(endpoint.id).toBe(BROKEN);
  });

  it('has no top-level /v1/endpoints/:id route, because the API has none', async () => {
    // `EndpointsController` is mounted at `projects/:projectId/endpoints`; the
    // project id is what the tenant resolver reads the organization off. A mock
    // that served the shorter path would hide a 404 until the transport flipped.
    const error = await failure(mockRequest('GET', `/v1/endpoints/${BROKEN}`));
    expect(error.status).toBe(404);
  });

  it('answers 404 — not 403 — for an endpoint in another project', async () => {
    // One answer for "does not exist" and "belongs to someone else". A 403 here
    // would confirm that an id scraped from somewhere is live infrastructure.
    const other = db.projects.find((project) => project.id !== PROJECT);
    const error = await failure(
      mockRequest('GET', `/v1/projects/${other?.id}/endpoints/${BROKEN}`),
    );
    expect(error.status).toBe(404);
    expect(error.body.error.code).toBe('not_found');
  });
});

describe('PATCH endpoint', () => {
  it('applies a partial update and leaves everything else alone', async () => {
    const before = db.endpoints.find((endpoint) => endpoint.id === BROKEN)!;
    const updated = await patchEndpoint(BROKEN, { timeout_ms: 5_000 });

    expect(updated.timeout_ms).toBe(5_000);
    expect(updated.name).toBe(before.name);
    expect(updated.url).toBe(before.url);
  });

  it('refuses an SSRF-shaped URL at save time, naming the field', async () => {
    // The Go dial-time guard is the authority; this is the usability mirror,
    // so the operator is told at the moment they press Save rather than
    // accumulating a day of `egress blocked` in the delivery log.
    for (const [url, reason] of [
      ['http://localhost:3000/hook', 'loopback address'],
      ['http://127.0.0.1/hook', 'loopback address'],
      ['http://10.0.0.5/hook', 'private address'],
      ['http://169.254.169.254/latest/meta-data', 'cloud instance metadata address'],
      ['ftp://files.example.com/hook', 'not permitted'],
      ['https://user:pw@example.com/hook', 'credentials in URL'],
    ] as const) {
      const error = await failure(patchEndpoint(BROKEN, { url }));
      expect(error.status).toBe(400);
      expect(error.body.error.code).toBe('invalid_request');
      // An ARRAY, exactly as the ValidationPipe produces one, so the dashboard
      // can put the reason under the URL input rather than in a paragraph.
      const messages = error.body.error.message as string[];
      expect(Array.isArray(messages)).toBe(true);
      expect(messages[0]).toContain('url: ');
      expect(messages[0]).toContain(reason);
    }
  });

  it('refuses a reserved custom header, and explains what it would allow', async () => {
    const error = await failure(
      patchEndpoint(BROKEN, { custom_headers: { 'Webhook-Signature': 'v1=forged' } }),
    );

    const messages = error.body.error.message as string[];
    expect(error.status).toBe(400);
    expect(messages[0]).toContain('custom_headers: ');
    expect(messages[0]).toContain('reserved');
  });

  it('refuses a status field rather than silently ignoring it', async () => {
    // `status` is not in `UpdateEndpointDto` and the pipe runs
    // `forbidNonWhitelisted`. Enabling has its own route with a precondition a
    // PATCH would walk past.
    const error = await failure(patchEndpoint(BROKEN, { status: 'active' }));
    const messages = error.body.error.message as string[];
    expect(error.status).toBe(400);
    expect(messages[0]).toContain('status');
    expect(messages.join(' ')).toContain('own routes');
  });

  it('reports every rejected field at once, not just the first', async () => {
    const error = await failure(
      patchEndpoint(BROKEN, { url: 'http://127.0.0.1/x', timeout_ms: 5 }),
    );
    const messages = error.body.error.message as string[];
    expect(messages).toHaveLength(2);
  });

  it('holds the numeric bounds that make per-endpoint isolation bounded', async () => {
    // `timeout_ms` is how long ONE tenant may hold a worker slot.
    expect((await failure(patchEndpoint(BROKEN, { timeout_ms: 600_000 }))).status).toBe(400);
    expect((await failure(patchEndpoint(BROKEN, { timeout_ms: 1 }))).status).toBe(400);
    expect((await failure(patchEndpoint(BROKEN, { max_concurrency: 0 }))).status).toBe(400);
    // A window of zero is a division by zero in whatever computes the refill.
    expect((await failure(patchEndpoint(BROKEN, { rate_limit_window_seconds: 0 }))).status).toBe(
      400,
    );
  });

  it('accepts null for rate_limit as "no per-endpoint limit"', async () => {
    const updated = await patchEndpoint(BROKEN, { rate_limit: null });
    expect(updated.rate_limit).toBeNull();
  });

  it('refuses every write against a soft-deleted endpoint with a 409', async () => {
    const error = await failure(patchEndpoint(DELETED, { timeout_ms: 5_000 }));
    expect(error.status).toBe(409);
    // Not a 404: the caller is inside the tenant and can still GET the row.
    expect(error.body.error.code).toBe('conflict');
  });

  it('answers 429 with retry_after_seconds once the update throttle trips', async () => {
    // The mock bucket allows 10; the eleventh is refused.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await patchEndpoint(BROKEN, { timeout_ms: 5_000 });
    }
    const error = await failure(patchEndpoint(BROKEN, { timeout_ms: 5_000 }));

    expect(error.status).toBe(429);
    expect(error.body.error.code).toBe('rate_limited');
    expect(error.body.error.details?.retry_after_seconds).toBeTypeOf('number');
  });
});

describe('enable and disable', () => {
  it('clears the breaker’s verdict when an endpoint is resumed', async () => {
    const resumed = await mockRequest<Endpoint>(
      'POST',
      `/v1/projects/${PROJECT}/endpoints/${BROKEN}/enable`,
    );

    expect(resumed.enabled).toBe(true);
    expect(resumed.status).toBe('active');
    expect(resumed.disabled_reason).toBeNull();
    expect(resumed.disabled_at).toBeNull();
  });

  it('refuses to enable an endpoint with no active signing secret', async () => {
    // The data plane fails CLOSED rather than delivering unsigned, so enabling
    // this one would queue failures instead of deliveries.
    const error = await failure(
      mockRequest('POST', `/v1/projects/${PROJECT}/endpoints/${NO_SECRET}/enable`),
    );

    expect(error.status).toBe(409);
    expect(error.body.error.code).toBe('conflict');
    expect(String(error.body.error.message)).toContain('signing secret');
  });

  it('records the operator’s reason when an endpoint is paused', async () => {
    const paused = await mockRequest<Endpoint>(
      'POST',
      `/v1/projects/${PROJECT}/endpoints/${BROKEN}/disable`,
      { reason: 'Partner incident PB-4471' },
    );

    expect(paused.enabled).toBe(false);
    expect(paused.status).toBe('paused');
    expect(paused.disabled_reason).toContain('PB-4471');
    expect(paused.disabled_at).not.toBeNull();
  });

  it('pausing an auto-disabled endpoint converts a verdict into a decision', async () => {
    // Before: the platform stopped it and `enabled` is still true, so nobody
    // chose the gap. After: a person did, with a reason, and the audit log can
    // explain it.
    const before = db.endpoints.find((endpoint) => endpoint.id === BROKEN)!;
    expect(before.enabled).toBe(true);
    expect(before.status).toBe('disabled');

    const paused = await mockRequest<Endpoint>(
      'POST',
      `/v1/projects/${PROJECT}/endpoints/${BROKEN}/disable`,
      {},
    );
    expect(paused.enabled).toBe(false);
  });

  it('refuses a reason longer than the column allows', async () => {
    const error = await failure(
      mockRequest('POST', `/v1/projects/${PROJECT}/endpoints/${BROKEN}/disable`, {
        reason: 'x'.repeat(201),
      }),
    );
    expect(error.status).toBe(400);
  });

  it('refuses both toggles on a deleted endpoint', async () => {
    expect(
      (await failure(mockRequest('POST', `/v1/projects/${PROJECT}/endpoints/${DELETED}/enable`)))
        .status,
    ).toBe(409);
    expect(
      (
        await failure(
          mockRequest('POST', `/v1/projects/${PROJECT}/endpoints/${DELETED}/disable`, {}),
        )
      ).status,
    ).toBe(409);
  });
});

describe('project and organization settings', () => {
  it('renames a project, and the row reflects it on the next read', async () => {
    const renamed = await mockRequest<Project>(
      'PATCH',
      `/v1/organizations/${ORG}/projects/${PROJECT}`,
      { name: 'Payments (live)' },
    );
    expect(renamed.name).toBe('Payments (live)');

    const reread = await mockRequest<Project>(
      'GET',
      `/v1/organizations/${ORG}/projects/${PROJECT}`,
    );
    expect(reread.name).toBe('Payments (live)');
  });

  it('refuses environment with a reason, not as an unknown-field typo', async () => {
    // Its absence from `UpdateProjectDto` is the enforcement, and
    // `ProjectsService.update` checks the key again so the message explains WHY.
    const error = await failure(
      mockRequest('PATCH', `/v1/organizations/${ORG}/projects/${PROJECT}`, {
        environment: 'test',
      }),
    );
    const messages = error.body.error.message as string[];

    expect(error.status).toBe(400);
    expect(messages[0]).toContain('environment: ');
    expect(messages[0]).toContain('re-point live traffic');
  });

  it('refuses a slug that does not match the pattern', async () => {
    const error = await failure(
      mockRequest('PATCH', `/v1/organizations/${ORG}/projects/${PROJECT}`, {
        slug: 'Payments Live',
      }),
    );
    const messages = error.body.error.message as string[];
    expect(error.status).toBe(400);
    expect(messages[0]).toContain('slug: ');
  });

  it('renames an organization', async () => {
    const renamed = await mockRequest<Organization>('PATCH', `/v1/organizations/${ORG}`, {
      name: 'ShaQ Express Ltd',
    });
    expect(renamed.name).toBe('ShaQ Express Ltd');
    expect(renamed.updated_at).toBeTypeOf('string');
  });

  it('refuses status on an organization — suspension is not self-service', async () => {
    const error = await failure(
      mockRequest('PATCH', `/v1/organizations/${ORG}`, { status: 'active' }),
    );
    expect(error.status).toBe(400);
    expect((error.body.error.message as string[])[0]).toContain('status');
  });

  it('refuses a name shorter than an organization name may be', async () => {
    const error = await failure(mockRequest('PATCH', `/v1/organizations/${ORG}`, { name: 'A' }));
    expect(error.status).toBe(400);
  });
});

describe('subscription writes — the failures the form has to render', () => {
  const create = (body: Record<string, unknown>) =>
    mockRequest<Subscription>('POST', `/v1/projects/${PROJECT}/subscriptions`, body);
  const messagesOf = (error: MockHttpError) => error.body.error.message as string[];

  it('refuses an empty event_types list, naming both alternatives', async () => {
    const error = await failure(create({ endpoint_id: 'ep_01JQFINANCE', event_types: [] }));
    expect(error.status).toBe(400);
    expect(messagesOf(error)[0]).toMatch(/must not be empty/);
    expect(messagesOf(error)[0]).toMatch(/enabled=false/);
  });

  it('refuses duplicates rather than de-duplicating', async () => {
    const error = await failure(
      create({ endpoint_id: 'ep_01JQFINANCE', event_types: ['a.b', 'a.b'] }),
    );
    expect(messagesOf(error)[0]).toBe('event_types[1] repeats "a.b"');
  });

  it('refuses whitespace rather than trimming it', async () => {
    const error = await failure(
      create({ endpoint_id: 'ep_01JQFINANCE', event_types: ['payment.settled '] }),
    );
    expect(messagesOf(error)[0]).toMatch(/byte for byte/);
  });

  it('refuses ".*"', async () => {
    const error = await failure(create({ endpoint_id: 'ep_01JQFINANCE', event_types: ['.*'] }));
    expect(messagesOf(error)[0]).toMatch(/write "\*" if you mean everything/);
  });

  it('refuses an empty payload_filter object, prefixed with the property', async () => {
    const error = await failure(
      create({ endpoint_id: 'ep_01JQFINANCE', event_types: ['*'], payload_filter: {} }),
    );
    expect(messagesOf(error)[0]).toMatch(/^payload_filter: is an empty object/);
  });

  it('refuses a payload_filter that is not an object', async () => {
    const error = await failure(
      create({ endpoint_id: 'ep_01JQFINANCE', event_types: ['*'], payload_filter: [1] }),
    );
    expect(messagesOf(error)[0]).toMatch(/^payload_filter must be a JSON object/);
  });

  it('refuses an unknown top-level $operator in a payload_filter', async () => {
    const error = await failure(
      create({
        endpoint_id: 'ep_01JQFINANCE',
        event_types: ['*'],
        payload_filter: { $contains: 'x' },
      }),
    );
    expect(messagesOf(error)[0]).toMatch(/^payload_filter\.\$contains: is not a supported operator/);
  });

  it('accepts a null payload_filter and a null name — both mean "none"', async () => {
    const created = await create({
      endpoint_id: 'ep_01JQFINANCE',
      event_types: ['*'],
      payload_filter: null,
      name: null,
    });
    expect(created.payload_filter).toBeNull();
    expect(created.name).toBeNull();
  });

  it('refuses a name over 200 characters under its own property', async () => {
    const error = await failure(
      create({ endpoint_id: 'ep_01JQFINANCE', event_types: ['*'], name: 'x'.repeat(201) }),
    );
    expect(messagesOf(error)[0]).toMatch(/^name: /);
  });

  it('refuses a PATCH with event_types: null as "must be an array"', async () => {
    const error = await failure(
      mockRequest('PATCH', `/v1/projects/${PROJECT}/subscriptions/sub_01JQFIN`, {
        event_types: null,
      }),
    );
    expect(messagesOf(error)[0]).toBe('event_types must be an array of strings');
  });

  it('refuses re-pointing a PATCH at a deleted endpoint with a 409 conflict', async () => {
    const error = await failure(
      mockRequest('PATCH', `/v1/projects/${PROJECT}/subscriptions/sub_01JQFIN`, {
        endpoint_id: DELETED,
      }),
    );
    expect(error.status).toBe(409);
    expect(error.body.error.code).toBe('conflict');
  });

  it('refuses a disable reason over 200 characters', async () => {
    const error = await failure(
      mockRequest('POST', `/v1/projects/${PROJECT}/subscriptions/sub_01JQFIN/disable`, {
        reason: 'x'.repeat(201),
      }),
    );
    expect(error.status).toBe(400);
    expect(messagesOf(error)[0]).toMatch(/^reason: /);
  });

  it('answers 404 for a subscription in another project, and 429 past the mutate bucket', async () => {
    const other = db.projects.find((project) => project.id !== PROJECT);
    const notFound = await failure(
      mockRequest('POST', `/v1/projects/${other!.id}/subscriptions/sub_01JQFIN/enable`),
    );
    expect(notFound.status).toBe(404);

    let throttled: MockHttpError | null = null;
    for (let index = 0; index < 25; index += 1) {
      try {
        await mockRequest('POST', `/v1/projects/${PROJECT}/subscriptions/sub_01JQFIN/enable`);
      } catch (error) {
        throttled = error as MockHttpError;
        break;
      }
    }
    expect(throttled?.status).toBe(429);
    expect(throttled?.body.error.details).toEqual({ retry_after_seconds: 42 });
  });
});

describe('project create — the failures the dialog has to render', () => {
  it('refuses a name that derives to no slug and asks for one explicitly', async () => {
    const error = await failure(
      mockRequest('POST', `/v1/organizations/${ORG}/projects`, { name: '!!!' }),
    );
    expect(error.status).toBe(400);
    expect(error.body.error.message).toMatch(/Supply "slug" explicitly/);
  });

  it('refuses a supplied slug that breaks the pattern, under the slug property', async () => {
    const error = await failure(
      mockRequest('POST', `/v1/organizations/${ORG}/projects`, {
        name: 'Ops',
        slug: 'Ops Live',
      }),
    );
    expect(error.status).toBe(400);
    expect((error.body.error.message as string[])[0]).toMatch(/^slug: /);
  });

  it('refuses an environment outside test | live', async () => {
    const error = await failure(
      mockRequest('POST', `/v1/organizations/${ORG}/projects`, {
        name: 'Ops',
        environment: 'production',
      }),
    );
    expect((error.body.error.message as string[])[0]).toMatch(/^environment: /);
  });

  it('refuses the missing name under its property', async () => {
    const error = await failure(mockRequest('POST', `/v1/organizations/${ORG}/projects`, {}));
    expect((error.body.error.message as string[])[0]).toMatch(/^name: /);
  });

  it('answers 404 for a project delete in an organization that does not own it', async () => {
    const other = db.organizations.find((organization) => organization.id !== ORG);
    const error = await failure(
      mockRequest('DELETE', `/v1/organizations/${other!.id}/projects/${PROJECT}`),
    );
    expect(error.status).toBe(404);
  });
});

/**
 * The publish allowlist.
 *
 * A deny-by-default control, so the tests are about what happens to an entry
 * the server cannot parse and about the list being replaced rather than merged.
 */
describe('project allowed_ips — a deny-by-default control', () => {
  const PATCH = `/v1/organizations/${ORG}/projects/${PROJECT}`;

  it('starts empty, which means every address may publish', async () => {
    const project = await mockRequest<Project>('GET', `/v1/organizations/${ORG}/projects/${PROJECT}`);
    expect(project.allowed_ips).toEqual([]);
  });

  it('REFUSES a malformed entry rather than saving the rest', async () => {
    // Silently dropping it would lock out the service it was for, at the
    // moment the operator believed they had just permitted it.
    await expect(
      mockRequest('PATCH', PATCH, { allowed_ips: ['203.0.113.0/24', 'not-an-ip'] }),
    ).rejects.toMatchObject({ status: 400 });

    const project = await mockRequest<Project>('GET', `/v1/organizations/${ORG}/projects/${PROJECT}`);
    expect(project.allowed_ips).toEqual([]);
  });

  it('REPLACES the list, so an address can actually be removed', async () => {
    // A merge would make removal impossible through this route, and an
    // allowlist you cannot shrink is not a security control.
    await mockRequest('PATCH', PATCH, { allowed_ips: ['203.0.113.4', '198.51.100.0/24'] });
    await mockRequest('PATCH', PATCH, { allowed_ips: ['203.0.113.4'] });

    const project = await mockRequest<Project>('GET', `/v1/organizations/${ORG}/projects/${PROJECT}`);
    expect(project.allowed_ips).toEqual(['203.0.113.4']);
  });

  it('collapses duplicates and ignores blanks', async () => {
    await mockRequest('PATCH', PATCH, { allowed_ips: ['203.0.113.4', ' ', '203.0.113.4'] });
    const project = await mockRequest<Project>('GET', `/v1/organizations/${ORG}/projects/${PROJECT}`);
    expect(project.allowed_ips).toEqual(['203.0.113.4']);
  });
});

/**
 * Notification destinations.
 *
 * `pending` is the state the UI is built around, so the tests are about a
 * destination existing and receiving nothing until somebody confirms it.
 */
describe('notification destinations — silent until somebody says yes', () => {
  const PATH = `/v1/projects/${PROJECT}/notification-destinations`;

  it('is created PENDING, so it receives nothing yet', async () => {
    const created = await mockRequest<NotificationDestination>('POST', PATH, {
      kind: 'email',
      target: 'New-OnCall@Example.com',
    });
    expect(created.status).toBe('pending');
    expect(created.confirmed_at).toBeNull();
    // Lower-cased on the way in, so the same mailbox cannot be added twice
    // under two spellings and receive everything twice.
    expect(created.target).toBe('new-oncall@example.com');
  });

  it('refuses the same address twice', async () => {
    await mockRequest('POST', PATH, { kind: 'email', target: 'dup@example.com' });
    await expect(
      mockRequest('POST', PATH, { kind: 'email', target: 'dup@example.com' }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('refuses Slack with a reason rather than creating a row nothing can reach', async () => {
    await expect(
      mockRequest('POST', PATH, { kind: 'slack', target: '#payments' }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('refuses to test an unconfirmed address', async () => {
    const created = await mockRequest<NotificationDestination>('POST', PATH, {
      kind: 'email',
      target: 'untested@example.com',
    });
    await expect(
      mockRequest('POST', `${PATH}/${created.id}/test`, {}),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('mutes by emptying the event list, which keeps the confirmation', async () => {
    // The expensive part of a destination is that somebody read the mailbox and
    // clicked a link. Deleting to mute throws that away.
    const confirmed = db.notificationDestinations.find((row) => row.status === 'confirmed');
    expect(confirmed).toBeDefined();

    const muted = await mockRequest<NotificationDestination>(
      'PATCH',
      `${PATH}/${confirmed!.id}`,
      { events: [] },
    );
    expect(muted.events).toEqual([]);
    expect(muted.status).toBe('confirmed');
  });
});

/**
 * Copying a project.
 *
 * Both tests are about the one rule that makes this safe to offer: what comes
 * across cannot send, and a secret never comes across at all.
 */
describe('project templating — nothing copied can deliver', () => {
  it('copies endpoints PAUSED, with no live secret and a reason saying why', async () => {
    const created = await mockRequest<Project & { copied: { endpoints: number; signing_secrets: number } }>(
      'POST',
      `/v1/organizations/${ORG}/projects`,
      { name: 'Copied', environment: 'test', copy_from_project_id: PROJECT },
    );

    expect(created.copied.endpoints).toBeGreaterThan(0);
    // Stated out loud, because that zero is the reason nothing delivers yet.
    expect(created.copied.signing_secrets).toBe(0);

    const copied = db.endpoints.filter((row) => row.project_id === created.id);
    expect(copied.length).toBe(created.copied.endpoints);
    for (const row of copied) {
      expect(row.status).toBe('paused');
      expect(row.enabled).toBe(false);
      expect(row.has_live_secret).toBe(false);
    }
  });

  it('never points a copied subscription at the source project’s endpoint', async () => {
    // That would deliver the new project's events into the old project's
    // consumer — silently, and to a URL nobody re-checked.
    const created = await mockRequest<Project>('POST', `/v1/organizations/${ORG}/projects`, {
      name: 'Copied again',
      environment: 'test',
      copy_from_project_id: PROJECT,
    });

    const newEndpointIds = new Set(
      db.endpoints.filter((row) => row.project_id === created.id).map((row) => row.id),
    );
    for (const subscription of db.subscriptions.filter((row) => row.project_id === created.id)) {
      expect(newEndpointIds.has(subscription.endpoint_id)).toBe(true);
    }
  });
});
