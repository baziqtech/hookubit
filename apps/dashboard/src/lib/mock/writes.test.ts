import { beforeEach, describe, expect, it } from 'vitest';
import type { Endpoint, Organization, Project } from '../../types/api';
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
