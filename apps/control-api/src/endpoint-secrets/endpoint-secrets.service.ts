import { Injectable, Logger } from '@nestjs/common';
import { Endpoint, EndpointSecret } from '@prisma/client';
import {
  AuditService,
  CROSS_TENANT_MESSAGE,
  MAX_PAGE_SIZE,
  RequestContext,
  TenantScope,
  TenantScopeFactory,
} from '../authz';
import { CryptoService } from '../common/crypto.service';
import { AppError } from '../common/errors';
import { newId } from '../common/ids';
import {
  EndpointSecretDto,
  RotatedSecretDto,
  isEffectivelyActive,
  toEndpointSecretDto,
} from './dto';
import {
  DEFAULT_OVERLAP_SECONDS,
  generateSigningSecret,
} from './secret-generator';

/** The physical table, for the encryption AAD. Must match `@@map` in the schema. */
const SECRETS_TABLE = 'endpoint_secrets';

/**
 * HMAC signing secrets, and the rotation window that makes them rollable.
 *
 * ## The invariant this service exists to hold
 *
 * `signing.Header` (services/data-plane/internal/signing/signing.go) returns
 * `ErrNoSecrets` when an endpoint has no active secret. It fails CLOSED on
 * purpose - a header with no `v1=` component is rejected by `Verify`, so
 * delivering unsigned would just be a delivery that cannot be verified, dressed
 * up as a success. The consequence lands here:
 *
 * > **A live endpoint must ALWAYS have at least one active, unexpired secret,
 * > and no operation in this service may leave it with none.**
 *
 * Four paths could break it and each is closed explicitly:
 *
 * 1. **Creation.** An endpoint is created paused and only becomes active once
 *    its version 1 secret exists (`EndpointsService.create`).
 * 2. **Enabling.** `EndpointsService.enable` refuses an endpoint with no live
 *    secret rather than resuming deliveries that cannot be signed.
 * 3. **Rotation.** The new secret is inserted BEFORE the old ones are given an
 *    expiry, so a failure between the two statements leaves two live secrets -
 *    never zero. See `rotate`.
 * 4. **Revocation.** `revoke` refuses to deactivate the last live secret of an
 *    endpoint that is not deleted.
 *
 * ## Why rotation overlaps rather than swaps
 *
 * `Header` emits one `v1=` per active secret and `Verify` accepts the delivery
 * if ANY of them matches. So while both secrets are active, a consumer holding
 * either one verifies successfully, and the customer can redeploy at their own
 * pace. Deactivating the old secret at the moment the new one is issued would
 * break every consumer in the gap between "we rotated" and "they deployed" -
 * which is the whole failure mode rotation is meant to avoid.
 *
 * ## Secrets in this file
 *
 * The plaintext exists in memory for the length of one request and is returned
 * exactly once, in the response to the call that created it. It is never
 * returned by a read path (`EndpointSecretDto` has no field it could occupy),
 * never written to a log, and never put in audit metadata - `AuditService`
 * would redact a key called `secret` anyway, and this code does not rely on
 * that.
 */
@Injectable()
export class EndpointSecretsService {
  private readonly logger = new Logger(EndpointSecretsService.name);

  constructor(
    private readonly scopes: TenantScopeFactory,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Metadata for every secret on the endpoint, newest first. No plaintext, by
   * construction: the only thing that can decrypt `secret_encrypted` is
   * `rotate`, and it decrypts nothing - it encrypts a value it just generated.
   */
  async list(context: RequestContext, endpointId: string): Promise<EndpointSecretDto[]> {
    const scope = this.scopes.for(context);
    await this.requireEndpoint(scope, endpointId);
    const now = new Date();
    const secrets = await this.secretsFor(scope, endpointId);
    return secrets.map((secret) => toEndpointSecretDto(secret, now));
  }

  /**
   * Issue a new secret and start the overlap window on the current ones.
   *
   * Statement order is the safety property, and it is not arbitrary:
   *
   *   1. INSERT the new secret, active, with no expiry.
   *   2. UPDATE the previously active secrets to expire at `now + overlap`.
   *
   * There is no transaction around the pair - `ScopedRepository` cannot open one
   * without the raw client, and injecting it is banned here. That is acceptable
   * *only* in this order: a crash between the two leaves the endpoint with two
   * live secrets and a stale overlap, which is a cosmetic problem a second
   * rotation fixes. The reverse order would leave a window with zero live
   * secrets and every delivery failing closed. When a transactional path exists,
   * wrap the pair; do not reorder it.
   *
   * Concurrency is handled by the database, not by a lock: `endpoint_secrets`
   * has `@@unique([endpointId, version])`, so two simultaneous rotations cannot
   * both claim the next version. The loser gets a `conflict` and retries.
   */
  async rotate(
    context: RequestContext,
    endpointId: string,
    overlapSeconds: number = DEFAULT_OVERLAP_SECONDS,
  ): Promise<RotatedSecretDto> {
    const scope = this.scopes.for(context);
    const endpoint = await this.requireEndpoint(scope, endpointId);
    if (endpoint.status === 'deleted') {
      throw new AppError(
        'conflict',
        'This endpoint is deleted. Rotating a secret for it would create a credential nothing can use.',
      );
    }

    const now = new Date();
    const existing = await this.secretsFor(scope, endpointId);
    const liveBefore = existing.filter((secret) => isEffectivelyActive(secret, now));

    // 1. The new secret first. Everything after this point can fail without
    //    taking the endpoint below one live secret.
    const created = await this.insertSecret(scope, endpointId, existing, now);

    // 2. Now, and only now, put a clock on the old ones.
    const expiresAt = new Date(now.getTime() + overlapSeconds * 1_000);
    const overlapping = liveBefore.filter(
      (secret) =>
        secret.expiresAt === null || new Date(secret.expiresAt).getTime() > expiresAt.getTime(),
    );
    if (overlapping.length > 0) {
      await scope.endpointSecrets.updateMany(
        { endpointId, id: { in: overlapping.map((secret) => secret.id) } },
        { expiresAt, rotatedAt: now },
      );
    }

    // Housekeeping, deliberately after the invariant is already safe: secrets
    // whose window closed before this rotation are flipped inactive so the
    // signing header does not have to re-derive that on every delivery, and so
    // the active set stays small however many times an endpoint is rotated.
    await this.sweepExpired(scope, endpointId, existing, now);

    await this.audit.recordFor(context, {
      action: 'endpoint_secret.rotated',
      resourceType: 'endpoint_secret',
      resourceId: created.row.id,
      metadata: {
        endpoint_id: endpointId,
        version: created.row.version,
        overlap_seconds: overlapSeconds,
        previous_versions: overlapping.map((secret) => secret.version),
        previous_secrets_expire_at: overlapping.length > 0 ? expiresAt.toISOString() : null,
      },
    });

    return {
      ...toEndpointSecretDto(created.row, now),
      // The one and only time this value crosses the wire.
      secret: created.plaintext,
      previous_secrets_expire_at: overlapping.length > 0 ? expiresAt.toISOString() : null,
      overlapping_versions: overlapping.map((secret) => secret.version),
    };
  }

  /**
   * Stop a specific secret signing, immediately.
   *
   * Refused when it is the last live secret of an endpoint that still exists,
   * because that is precisely the state `signing.Header` refuses to sign in. The
   * caller is told to rotate instead, which produces the same end state (that
   * secret stops signing) without the outage in between: `rotate` with
   * `overlap_seconds: 0` is the "this secret has leaked" button.
   */
  async revoke(
    context: RequestContext,
    endpointId: string,
    secretId: string,
  ): Promise<EndpointSecretDto> {
    const scope = this.scopes.for(context);
    const endpoint = await this.requireEndpoint(scope, endpointId);

    const now = new Date();
    const secrets = await this.secretsFor(scope, endpointId);
    const target = secrets.find((secret) => secret.id === secretId);
    // Not "which endpoint does this secret belong to?" - `secretsFor` is already
    // fenced to this endpoint inside this tenant, so a secret from anywhere else
    // is simply absent here.
    if (!target) throw new AppError('not_found', CROSS_TENANT_MESSAGE);

    const survivors = secrets.filter(
      (secret) => secret.id !== secretId && isEffectivelyActive(secret, now),
    );
    if (survivors.length === 0 && endpoint.status !== 'deleted') {
      throw new AppError(
        'conflict',
        'This is the only secret currently signing for this endpoint. Removing it would make ' +
          'every delivery fail unsigned. Rotate instead - use an overlap of 0 seconds if this ' +
          'secret has leaked and must stop signing immediately.',
      );
    }

    await scope.endpointSecrets.updateMany(
      { endpointId, id: secretId },
      { active: false, expiresAt: now, rotatedAt: now },
    );

    await this.audit.recordFor(context, {
      action: 'endpoint_secret.revoked',
      resourceType: 'endpoint_secret',
      resourceId: secretId,
      metadata: { endpoint_id: endpointId, version: target.version },
    });

    return toEndpointSecretDto({ ...target, active: false, expiresAt: now, rotatedAt: now }, now);
  }

  /**
   * The version 1 secret for a brand-new endpoint.
   *
   * Called by `EndpointsService.create` while the endpoint is still paused, so
   * the endpoint never exists in an active-with-no-secret state. Separate from
   * `rotate` because there is nothing to overlap with and no audit action named
   * "rotated" would be true.
   */
  async mintInitial(
    context: RequestContext,
    endpointId: string,
  ): Promise<{ secret: string; version: number; id: string }> {
    const scope = this.scopes.for(context);
    const created = await this.insertSecret(scope, endpointId, [], new Date());
    await this.audit.recordFor(context, {
      action: 'endpoint_secret.created',
      resourceType: 'endpoint_secret',
      resourceId: created.row.id,
      metadata: { endpoint_id: endpointId, version: created.row.version },
    });
    return { secret: created.plaintext, version: created.row.version, id: created.row.id };
  }

  /**
   * Does this endpoint have a secret that would actually sign right now?
   *
   * `EndpointsService.enable` asks before resuming deliveries. It reads the same
   * rows through the same tenant scope, so an endpoint in another tenant is
   * "no" for the same reason everything else about it is a 404.
   */
  async hasLiveSecret(context: RequestContext, endpointId: string): Promise<boolean> {
    const scope = this.scopes.for(context);
    const now = new Date();
    const secrets = await this.secretsFor(scope, endpointId);
    return secrets.some((secret) => isEffectivelyActive(secret, now));
  }

  // ---------------------------------------------------------------------------

  /**
   * The endpoint, proved to be in this tenant, through the scope.
   *
   * This is also what makes the secret write legal: `endpoint_secrets` has no
   * tenant column of its own, so the parent is the tenancy. Resolving it here
   * first - and passing only the scalar id onward - is the pattern
   * `ScopedRepository` asks for.
   */
  private async requireEndpoint(scope: TenantScope, endpointId: string): Promise<Endpoint> {
    const endpoint = await scope.endpoints.findById(endpointId);
    if (!endpoint) throw new AppError('not_found', CROSS_TENANT_MESSAGE);
    return endpoint;
  }

  private async secretsFor(scope: TenantScope, endpointId: string): Promise<EndpointSecret[]> {
    const secrets = await scope.endpointSecrets.findMany({
      where: { endpointId },
      orderBy: { version: 'desc' },
      take: MAX_PAGE_SIZE,
    });
    // Do not trust the page for ordering decisions; sort what came back.
    return [...secrets].sort((a, b) => b.version - a.version);
  }

  /**
   * Encrypt and insert one secret, returning the row and the plaintext.
   *
   * The row id is minted before the ciphertext because the id is part of the
   * AES-GCM additional authenticated data, together with the table and the
   * owning endpoint. That binding is what stops someone with database write
   * access from moving a ciphertext - or re-pointing this row's `endpoint_id` -
   * so that the platform signs another endpoint's traffic with a secret they
   * control. See the `EncryptionContext` docblock in `common/crypto.service.ts`.
   */
  private async insertSecret(
    scope: TenantScope,
    endpointId: string,
    existing: readonly EndpointSecret[],
    now: Date,
  ): Promise<{ row: EndpointSecret; plaintext: string }> {
    const id = newId('endpointSecret');
    const plaintext = generateSigningSecret();
    const version = existing.reduce((highest, secret) => Math.max(highest, secret.version), 0) + 1;

    try {
      const row = await scope.endpointSecrets.create({
        id,
        endpointId,
        secretEncrypted: this.crypto.encrypt(plaintext, {
          table: SECRETS_TABLE,
          id,
          owner: endpointId,
        }),
        version,
        active: true,
        createdAt: now,
        expiresAt: null,
      });
      return { row, plaintext };
    } catch (err) {
      if (EndpointSecretsService.isUniqueViolation(err)) {
        // `@@unique([endpointId, version])` did its job: another rotation took
        // this version between our read and our write. Nothing was written, so
        // the endpoint's live secrets are exactly as they were.
        this.logger.warn(
          `Concurrent rotation on endpoint ${endpointId}: version ${version} was already taken.`,
        );
        throw new AppError(
          'conflict',
          'Another rotation for this endpoint is in progress. Retry the request.',
        );
      }
      throw err;
    }
  }

  /**
   * Flip `active` to false on secrets whose window has already closed.
   *
   * Purely housekeeping - `isEffectivelyActive` and the data plane's loader both
   * already treat an expired row as not signing - so it is never the thing that
   * holds the invariant, and it runs only after a new secret exists.
   */
  private async sweepExpired(
    scope: TenantScope,
    endpointId: string,
    secrets: readonly EndpointSecret[],
    now: Date,
  ): Promise<void> {
    const stale = secrets.filter(
      (secret) =>
        secret.active &&
        secret.expiresAt !== null &&
        new Date(secret.expiresAt).getTime() <= now.getTime(),
    );
    if (stale.length === 0) return;
    await scope.endpointSecrets.updateMany(
      { endpointId, id: { in: stale.map((secret) => secret.id) } },
      { active: false },
    );
  }

  /** Duck-typed: the fake used in tests does not throw Prisma's error class. */
  private static isUniqueViolation(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      (err as { code?: unknown }).code === 'P2002'
    );
  }
}
