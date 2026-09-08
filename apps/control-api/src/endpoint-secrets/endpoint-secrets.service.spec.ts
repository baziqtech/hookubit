import { createHmac } from 'node:crypto';
import { CROSS_TENANT_MESSAGE, MAX_PAGE_SIZE, RequestContext } from '../authz';
// Not re-exported from the barrel; this is the redaction marker itself.
import { REDACTED } from '../authz/audit.service';
import { IDS } from '../authz/testing/fixtures';
import { AppError, ErrorCode } from '../common/errors';
import { CreateEndpointDto } from '../endpoints/dto';
import { isEffectivelyActive } from './dto';
import { DEFAULT_OVERLAP_SECONDS } from './secret-generator';
import { ENDPOINT_ANCHOR, Harness, harnessFor } from './testing/harness';

const BODY: CreateEndpointDto = { name: 'finance', url: 'https://finance.example.com/hook' };
const PAYLOAD = Buffer.from('{"id":"evt_1","type":"payment.settled"}');

async function expectError(
  promise: Promise<unknown>,
  code: ErrorCode,
  message?: string,
): Promise<AppError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    const error = err as AppError;
    expect(error.code).toBe(code);
    if (message !== undefined) expect(error.message).toBe(message);
    return error;
  }
  throw new Error(`expected the call to reject with ${code}, but it resolved`);
}

/**
 * `signing.Sign` from services/data-plane/internal/signing/signing.go, restated
 * in TypeScript: HMAC-SHA256 over `<unix seconds> "." <raw payload bytes>`.
 *
 * Restated rather than imported because it IS the contract - if the Go side
 * changes shape, this test should be the thing that argues about it.
 */
function sign(secret: string, payload: Buffer, unixSeconds: number): string {
  const mac = createHmac('sha256', secret);
  mac.update(String(unixSeconds));
  mac.update('.');
  mac.update(payload);
  return mac.digest('hex');
}

/** `signing.Header`: one `t=`, then one `v1=` per ACTIVE secret. Fails closed. */
function header(activeSecrets: string[], payload: Buffer, unixSeconds: number): string {
  if (activeSecrets.length === 0) {
    throw new Error('signing: endpoint has no active secrets');
  }
  return [
    `t=${unixSeconds}`,
    ...activeSecrets.map((secret) => `v1=${sign(secret, payload, unixSeconds)}`),
  ].join(',');
}

/** `signing.Verify`: any matching `v1=` component is a pass. */
function verify(headerValue: string, secret: string, payload: Buffer): boolean {
  const parts = headerValue.split(',').map((part) => part.trim());
  const timestamp = Number(parts.find((part) => part.startsWith('t='))?.slice(2));
  const signatures = parts.filter((part) => part.startsWith('v1=')).map((part) => part.slice(3));
  if (!Number.isFinite(timestamp) || signatures.length === 0) return false;
  return signatures.includes(sign(secret, payload, timestamp));
}

async function withEndpoint(
  userId: string = IDS.ownerA,
): Promise<{ harness: Harness; endpointId: string; initialSecret: string }> {
  const harness = await harnessFor(userId, { orgId: IDS.orgA, projectId: IDS.projectA1 });
  const created = await harness.endpoints.create(harness.context, BODY);
  return { harness, endpointId: created.id, initialSecret: String(created.secret) };
}

/** The secrets the data plane would consider live, in the order it would sign. */
function liveSecrets(harness: Harness, endpointId: string, now = new Date()): string[] {
  return harness.db
    .all('endpointSecret')
    .filter((row) => row.endpointId === endpointId)
    .filter((row) =>
      isEffectivelyActive(
        {
          active: Boolean(row.active),
          expiresAt: (row.expiresAt ?? null) as Date | null,
        } as never,
        now,
      ),
    )
    .sort((a, b) => Number(a.version) - Number(b.version))
    .map((row) =>
      harness.crypto.decrypt(String(row.secretEncrypted), {
        table: 'endpoint_secrets',
        id: String(row.id),
        owner: endpointId,
      }),
    );
}

describe('rotation - the overlap window', () => {
  it('leaves BOTH secrets active, and a delivery in the window verifies with either', async () => {
    const { harness, endpointId, initialSecret } = await withEndpoint();

    const rotated = await harness.secrets.rotate(harness.context, endpointId);

    // 1. Two rows, both signing.
    const live = liveSecrets(harness, endpointId);
    expect(live).toHaveLength(2);
    expect(live).toEqual(expect.arrayContaining([initialSecret, rotated.secret]));

    // 2. The old one is NOT deactivated - it is given a deadline.
    const old = harness.db
      .all('endpointSecret')
      .find((row) => row.endpointId === endpointId && row.version === 1);
    expect(old?.active).toBe(true);
    expect(old?.expiresAt).toBeInstanceOf(Date);
    expect(rotated.overlapping_versions).toEqual([1]);
    expect(rotated.previous_secrets_expire_at).not.toBeNull();

    // 3. What the consumer actually sees: one header, two v1 components, and a
    //    consumer holding EITHER secret verifies. That is what lets them roll.
    const now = Math.floor(Date.now() / 1000);
    const value = header(live, PAYLOAD, now);
    expect(value.match(/v1=/g)).toHaveLength(2);
    expect(verify(value, initialSecret, PAYLOAD)).toBe(true);
    expect(verify(value, rotated.secret, PAYLOAD)).toBe(true);
    expect(verify(value, 'whsec_not_this_one', PAYLOAD)).toBe(false);
  });

  it('defaults the window to a day and honours an explicit one', async () => {
    const { harness, endpointId } = await withEndpoint();

    const before = Date.now();
    const rotated = await harness.secrets.rotate(harness.context, endpointId);
    const expiry = new Date(String(rotated.previous_secrets_expire_at)).getTime();
    expect(expiry).toBeGreaterThanOrEqual(before + DEFAULT_OVERLAP_SECONDS * 1_000);
    expect(expiry).toBeLessThan(before + (DEFAULT_OVERLAP_SECONDS + 60) * 1_000);

    const short = await harness.secrets.rotate(harness.context, endpointId, 60);
    expect(new Date(String(short.previous_secrets_expire_at)).getTime()).toBeLessThan(
      Date.now() + 61_000,
    );
  });

  /**
   * The leak button. Zero overlap is safe ONLY because the new secret is
   * inserted before the old ones are expired, so the endpoint never passes
   * through zero live secrets.
   */
  it('an overlap of 0 stops the old secret at once, and still leaves one signing', async () => {
    const { harness, endpointId, initialSecret } = await withEndpoint();

    const rotated = await harness.secrets.rotate(harness.context, endpointId, 0);

    const live = liveSecrets(harness, endpointId, new Date(Date.now() + 1_000));
    expect(live).toEqual([rotated.secret]);
    expect(live).not.toContain(initialSecret);
    expect(live.length).toBeGreaterThan(0);
  });

  it('versions monotonically and keeps the active set bounded across many rotations', async () => {
    const { harness, endpointId } = await withEndpoint();

    for (let i = 0; i < 5; i += 1) {
      await harness.secrets.rotate(harness.context, endpointId, 0);
    }

    const versions = harness.db
      .all('endpointSecret')
      .filter((row) => row.endpointId === endpointId)
      .map((row) => Number(row.version))
      .sort((a, b) => a - b);
    expect(versions).toEqual([1, 2, 3, 4, 5, 6]);

    // Every superseded secret is expired; only the newest still signs, so the
    // signature header does not grow without bound.
    expect(liveSecrets(harness, endpointId, new Date(Date.now() + 1_000))).toHaveLength(1);
  });

  it('reports a concurrent rotation as a conflict rather than corrupting the version line', async () => {
    const { harness, endpointId } = await withEndpoint();
    jest
      .spyOn(harness.db.endpointSecret, 'create')
      .mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }));

    await expectError(harness.secrets.rotate(harness.context, endpointId), 'conflict');
    // Nothing was written, so the endpoint still has exactly its original secret.
    expect(liveSecrets(harness, endpointId)).toHaveLength(1);
  });
});

describe('the zero-active-secrets invariant', () => {
  it('never leaves an endpoint with no live secret, whatever order operations arrive in', async () => {
    const { harness, endpointId } = await withEndpoint();
    const context = harness.context;

    const operations: Array<() => Promise<unknown>> = [
      () => harness.secrets.rotate(context, endpointId),
      () => harness.secrets.rotate(context, endpointId, 0),
      () => harness.endpoints.disable(context, endpointId),
      () => harness.endpoints.enable(context, endpointId),
      () => harness.secrets.rotate(context, endpointId, 3_600),
    ];

    for (const operation of operations) {
      await operation();
      expect(liveSecrets(harness, endpointId).length).toBeGreaterThanOrEqual(1);
    }
  });

  it('refuses to revoke the last secret still signing', async () => {
    const { harness, endpointId } = await withEndpoint();
    const [only] = (await harness.secrets.list(harness.context, endpointId)).data;

    const error = await expectError(
      harness.secrets.revoke(harness.context, endpointId, only.id),
      'conflict',
    );
    expect(error.message).toContain('only secret currently signing');
    expect(liveSecrets(harness, endpointId)).toHaveLength(1);
  });

  it('allows revoking a superseded secret during the overlap window', async () => {
    const { harness, endpointId } = await withEndpoint();
    const rotated = await harness.secrets.rotate(harness.context, endpointId);
    const version1 = (await harness.secrets.list(harness.context, endpointId)).data.find(
      (secret) => secret.version === 1,
    );

    const revoked = await harness.secrets.revoke(
      harness.context,
      endpointId,
      String(version1?.id),
    );

    expect(revoked.active).toBe(false);
    expect(liveSecrets(harness, endpointId)).toEqual([rotated.secret]);
  });

  it('refuses to rotate a deleted endpoint rather than minting an unusable credential', async () => {
    const { harness, endpointId } = await withEndpoint();
    await harness.endpoints.remove(harness.context, endpointId);

    await expectError(harness.secrets.rotate(harness.context, endpointId), 'conflict');
  });
});

describe('the plaintext appears exactly once', () => {
  it('is returned by rotate, and by nothing else, ever', async () => {
    const { harness, endpointId } = await withEndpoint();

    const rotated = await harness.secrets.rotate(harness.context, endpointId);
    expect(rotated.secret).toMatch(/^whsec_/);

    // Read paths.
    const listed = (await harness.secrets.list(harness.context, endpointId)).data;
    expect(JSON.stringify(listed)).not.toContain(rotated.secret);
    for (const secret of listed) {
      expect(Object.keys(secret)).not.toContain('secret');
    }
    expect(JSON.stringify(await harness.endpoints.get(harness.context, endpointId))).not.toContain(
      rotated.secret,
    );

    // At rest, and in the audit log.
    const stored = harness.db.all('endpointSecret').map((row) => String(row.secretEncrypted));
    expect(stored.join('|')).not.toContain(rotated.secret);
    expect(JSON.stringify(harness.db.all('auditLog'))).not.toContain(rotated.secret);
  });

  it('binds the ciphertext to its own row AND its endpoint', async () => {
    const { harness, endpointId } = await withEndpoint();
    const rotated = await harness.secrets.rotate(harness.context, endpointId);
    const row = harness.db
      .all('endpointSecret')
      .find((candidate) => candidate.id === rotated.id);
    const envelope = String(row?.secretEncrypted);

    expect(
      harness.crypto.decrypt(envelope, {
        table: 'endpoint_secrets',
        id: rotated.id,
        owner: endpointId,
      }),
    ).toBe(rotated.secret);

    // Re-pointed at another endpoint: the AAD no longer matches, so an attacker
    // with database write access cannot make the platform sign another
    // endpoint's traffic with a secret they chose.
    expect(() =>
      harness.crypto.decrypt(envelope, {
        table: 'endpoint_secrets',
        id: rotated.id,
        owner: IDS.endpointB1,
      }),
    ).toThrow();
    // Copied into another row.
    expect(() =>
      harness.crypto.decrypt(envelope, {
        table: 'endpoint_secrets',
        id: 'eps_somewhere_else',
        owner: endpointId,
      }),
    ).toThrow();
  });
});

describe('tenant isolation and permissions', () => {
  it('answers 404 for an endpoint in another tenant, on every route', async () => {
    const { harness } = await withEndpoint();
    const context = harness.context;

    for (const call of [
      harness.secrets.list(context, IDS.endpointB1),
      harness.secrets.rotate(context, IDS.endpointB1),
      harness.secrets.revoke(context, IDS.endpointB1, IDS.secretB1),
    ]) {
      await expectError(call, 'not_found', CROSS_TENANT_MESSAGE);
    }
    // Nothing was written under the victim endpoint.
    expect(
      harness.db.all('endpointSecret').filter((row) => row.endpointId === IDS.endpointB1),
    ).toHaveLength(1);
  });

  it('cannot revoke a secret belonging to another endpoint in the same tenant', async () => {
    const { harness, endpointId } = await withEndpoint();
    const other = await harness.endpoints.create(harness.context, {
      ...BODY,
      url: 'https://other.example.com/hook',
    });
    const [otherSecret] = (await harness.secrets.list(harness.context, other.id)).data;

    await expectError(
      harness.secrets.revoke(harness.context, endpointId, otherSecret.id),
      'not_found',
      CROSS_TENANT_MESSAGE,
    );
    expect(liveSecrets(harness, other.id)).toHaveLength(1);
  });

  /**
   * `endpoint-secrets.*` is owner/admin ONLY and is deliberately not implied by
   * `endpoints.read`, which a viewer holds. The guard is what enforces it (see
   * the HTTP suite); this pins the matrix the guard reads, so a well-meaning
   * widening of the grant fails here too.
   */
  it('gives a viewer endpoints.read and withholds endpoint-secrets.read', async () => {
    const viewer = await harnessFor(IDS.viewerA, {
      orgId: IDS.orgA,
      projectId: IDS.projectA1,
    });
    expect(viewer.context.has('endpoints.read')).toBe(true);
    expect(viewer.context.has('endpoint-secrets.read')).toBe(false);
    expect(viewer.context.has('endpoint-secrets.write')).toBe(false);

    const developer = await harnessFor(IDS.developerA, {
      orgId: IDS.orgA,
      projectId: IDS.projectA1,
    });
    expect(developer.context.has('endpoints.write')).toBe(true);
    expect(developer.context.has('endpoint-secrets.read')).toBe(false);

    for (const role of [IDS.ownerA, IDS.adminA]) {
      const privileged = await harnessFor(role, { orgId: IDS.orgA, projectId: IDS.projectA1 });
      expect(privileged.context.has('endpoint-secrets.read')).toBe(true);
      expect(privileged.context.has('endpoint-secrets.write')).toBe(true);
    }
  });

  it('resolves the tenant from the endpoint id when the path names no project', async () => {
    const anchored = await harnessFor(IDS.ownerA, { endpointId: IDS.endpointA1 }, ENDPOINT_ANCHOR);
    expect(anchored.context.project?.id).toBe(IDS.projectA1);
    expect(anchored.context.organization.id).toBe(IDS.orgA);

    // The same route, addressed at another tenant's endpoint, never resolves.
    await expect(
      harnessFor(IDS.ownerA, { endpointId: IDS.endpointB1 }, ENDPOINT_ANCHOR),
    ).rejects.toMatchObject({ code: 'not_found', message: CROSS_TENANT_MESSAGE });
  });
});

describe('secret metadata', () => {
  it('reports an expired-but-not-swept row as inactive', async () => {
    const { harness, endpointId } = await withEndpoint();
    await harness.secrets.rotate(harness.context, endpointId, 1);

    const past = new Date(Date.now() + 5_000);
    const listed = (await harness.secrets.list(harness.context, endpointId)).data.map(
      (secret) => ({ version: secret.version, active: secret.active }),
    );
    // `list` uses "now", so both are still live at this instant...
    expect(listed).toEqual([
      { version: 2, active: true },
      { version: 1, active: true },
    ]);
    // ...and five seconds later the column still says active while the effective
    // answer - the one the data plane uses - is false.
    const version1 = harness.db
      .all('endpointSecret')
      .find((row) => row.endpointId === endpointId && row.version === 1);
    expect(version1?.active).toBe(true);
    expect(liveSecrets(harness, endpointId, past)).toHaveLength(1);
  });

  it('lists newest first and never returns another endpoint rows', async () => {
    const { harness, endpointId } = await withEndpoint();
    await harness.secrets.rotate(harness.context, endpointId);
    await harness.secrets.rotate(harness.context, endpointId);

    const listed = await harness.secrets.list(harness.context, endpointId);
    expect(listed.data.map((secret) => secret.version)).toEqual([3, 2, 1]);
    expect(listed.data.every((secret) => secret.endpoint_id === endpointId)).toBe(true);
    expect(listed).toMatchObject({ has_more: false, next_offset: null });
  });
});

/** Kept separate so a change to the fixture cannot make the suite vacuous. */
describe('sanity: the harness really enforces the parent check on create', () => {
  it('refuses a secret create under an endpoint outside the tenant', async () => {
    const harness = await harnessFor(IDS.ownerA, {
      orgId: IDS.orgA,
      projectId: IDS.projectA1,
    });
    const scope = harness.scopes.for(harness.context as RequestContext);

    await expect(
      scope.endpointSecrets.create({
        id: 'eps_evil',
        endpointId: IDS.endpointB1,
        secretEncrypted: 'v1.k1.a.b.c',
        version: 99,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(harness.db.rows('endpointSecret').get('eps_evil')).toBeUndefined();
  });
});

/**
 * FIX 4, now fixed at the rule rather than at this call site. The audit
 * redaction used to match any key CONTAINING "secret", so
 * `previous_secrets_expire_at` - a timestamp, and the single fact this row is
 * ever opened to answer - came back `[redacted]`, and the workaround was to
 * rename the key to `previous_expire_at`. `AuditService.isCredentialKey` now
 * decides on whole words and exempts a terminal `_at`, so the field carries its
 * real name again and the next author does not have to know the trap exists.
 */
describe('the rotation audit row keeps the one fact it is read for', () => {
  it('records when the previous secrets stop signing, unredacted, under its own name', async () => {
    const { harness, endpointId } = await withEndpoint();

    const rotated = await harness.secrets.rotate(harness.context, endpointId, 3_600);

    const entry = harness.db.all('auditLog').find((row) => row.action === 'endpoint_secret.rotated');
    const metadata = entry?.metadata as Record<string, unknown>;

    expect(metadata.previous_secrets_expire_at).toBe(rotated.previous_secrets_expire_at);
    expect(metadata.previous_secrets_expire_at).not.toBe(REDACTED);
    expect(String(metadata.previous_secrets_expire_at)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(metadata.previous_versions).toEqual([1]);
    // The policy still bites where it should: no plaintext anywhere in the row.
    expect(JSON.stringify(entry)).not.toContain(rotated.secret);
  });
});

/**
 * FIX 5. A secret whose own expiry already precedes the new overlap end is
 * correctly NOT extended - and it is still live, still emitting a `v1=`
 * component. Reporting only the extended set told a consumer rolling its
 * secrets off `overlapping_versions` that nothing else was signing.
 */
describe('rotation reports every prior version that is still signing', () => {
  it('includes versions this rotation did not extend, and the latest expiry of all of them', async () => {
    const { harness, endpointId } = await withEndpoint();

    // v1 gets a SHORT window...
    await harness.secrets.rotate(harness.context, endpointId, 60);
    // ...then v2 is superseded with a much longer one. v1's own expiry already
    // precedes the new overlap end, so it is left alone - and still signs.
    const third = await harness.secrets.rotate(harness.context, endpointId, 7_200);

    expect(third.overlapping_versions).toEqual([2, 1]);

    const live = liveSecrets(harness, endpointId);
    expect(live).toHaveLength(3);
    // Everything reported as still signing really is, and the reported deadline
    // is the LAST of them - which is what a consumer schedules its rollover on.
    const until = new Date(String(third.previous_secrets_expire_at)).getTime();
    expect(until).toBeGreaterThan(Date.now() + 7_000 * 1_000);
    expect(liveSecrets(harness, endpointId, new Date(until + 1_000))).toEqual([third.secret]);
  });

  it('reports nothing still signing when the overlap is zero', async () => {
    const { harness, endpointId } = await withEndpoint();

    const rotated = await harness.secrets.rotate(harness.context, endpointId, 0);

    expect(rotated.overlapping_versions).toEqual([]);
    expect(rotated.previous_secrets_expire_at).toBeNull();
    expect(liveSecrets(harness, endpointId, new Date(Date.now() + 1_000))).toEqual([
      rotated.secret,
    ]);
  });
});

/**
 * The reads that make DECISIONS are exhaustive, not one capped page.
 *
 * `secretsFor` feeds the next version number, the survivor count `revoke`
 * refuses on, and `hasLiveSecret`. Read as a single `take: MAX_PAGE_SIZE` page
 * it was correct for a realistic endpoint and wrong past 200 rows - and "wrong"
 * here means an endpoint that IS signable being reported as not, and a survivor
 * on page two being invisible to the check that exists to find it.
 */
describe('decisions are made over every secret, not the first page', () => {
  /** Ids sort before any ULID (`01M...`), so these fill the first pages. */
  function bulkSecrets(harness: Harness, endpointId: string, count: number): void {
    for (let i = 0; i < count; i += 1) {
      harness.db.insert('endpointSecret', {
        id: `eps_0000000000000000000${String(i).padStart(3, '0')}`,
        endpointId,
        secretEncrypted: 'v1.k1.a.b.c',
        version: 1_000 + i,
        active: false,
        expiresAt: new Date('2020-01-01T00:00:00.000Z'),
        createdAt: new Date('2020-01-01T00:00:00.000Z'),
      });
    }
  }

  it('finds a live secret sitting past MAX_PAGE_SIZE rows of dead ones', async () => {
    const { harness, endpointId } = await withEndpoint();
    await harness.endpoints.disable(harness.context, endpointId);
    bulkSecrets(harness, endpointId, MAX_PAGE_SIZE + 50);

    // The only live secret is the one minted with the endpoint, and every
    // bulk row sorts ahead of it. A single capped page never reaches it.
    await expect(harness.secrets.hasLiveSecret(harness.context, endpointId)).resolves.toBe(true);
    // Which is what `enable` asks before resuming deliveries.
    await expect(harness.endpoints.enable(harness.context, endpointId)).resolves.toMatchObject({
      status: 'active',
    });
  });

  it('counts a survivor past the first page when refusing a revoke', async () => {
    const { harness, endpointId } = await withEndpoint();
    const rotated = await harness.secrets.rotate(harness.context, endpointId, 7_200);
    bulkSecrets(harness, endpointId, MAX_PAGE_SIZE + 50);

    // v1 is still inside its overlap window, so revoking the NEW secret is
    // allowed - but only if the read that counts survivors got that far.
    const revoked = await harness.secrets.revoke(harness.context, endpointId, rotated.id);
    expect(revoked.active).toBe(false);
    expect(liveSecrets(harness, endpointId)).toHaveLength(1);
  });
});
