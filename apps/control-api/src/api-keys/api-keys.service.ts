import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiKey, MemberRole } from '@prisma/client';
import {
  AuditService,
  Permission,
  RequestContext,
  TenantScopeFactory,
  isPermission,
} from '../authz';
import {
  apiKeyEnvironment,
  generateApiKey,
  isValidApiKeyShape,
} from '../common/api-key';
import { AppError } from '../common/errors';
import { newId } from '../common/ids';
import { API_KEYS_PER_PROJECT, maxApiKeysPerProject } from './api-key-limits';
import {
  ApiKeyDto,
  ApiKeyListDto,
  CreateApiKeyDto,
  CreatedApiKeyDto,
  ListApiKeysQueryDto,
  toApiKeyDto,
} from './dto';
import { withCrossTenantNotFound } from './not-found';

/**
 * API keys: the server-to-server credential the Go ingest path authenticates
 * with (ARCHITECTURE.md 11).
 *
 * Three properties this service is responsible for, in order of how expensive
 * they are to get wrong:
 *
 * **1. The wire format is a contract with another process.** `src/common/
 * api-key.ts` and `services/data-plane/internal/ingest/apikey.go` must agree
 * character for character: lowercase-hex SHA-256 of the FULL plaintext, a
 * 12-character stored prefix, a 24-character minimum checked before hashing. If
 * they disagree by one character nothing authenticates, and the symptom is
 * "customer says their key is rejected" - which reads as a credential problem,
 * not as a bug in this file. So this service does not construct keys; it calls
 * `generateApiKey` and then asserts the result still satisfies the shared shape
 * check before writing it.
 *
 * **2. The plaintext exists for one response.** Only `key_hash` is persisted.
 * The plaintext is generated, returned in the 201, and dropped - it is never
 * logged, never audited, never in a list, and there is no endpoint that could
 * return it again.
 *
 * **3. Environment cannot be chosen by the caller.** It is taken from the
 * resolved project, so a `wk_live_` key cannot exist under a `test` project.
 * The ingest path re-checks the pair (`handler.go:169`) and would refuse a
 * mismatch anyway; this makes the mismatch unconstructible rather than merely
 * useless.
 */
@Injectable()
export class ApiKeysService {
  constructor(
    private readonly scopes: TenantScopeFactory,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  /**
   * One page of keys, newest first, revoked and expired included and labelled,
   * PLUS whether there are more. `toApiKeyDto` cannot leak the secret:
   * `key_hash` is not a field on the response type.
   *
   * `findPage` rather than `findMany`: a credential inventory that silently
   * stops at the default page is how "revoke everything" reports success over
   * the first fifty keys. `findMany` now throws in that situation rather than
   * lying, which would have turned this into a 500 on the fifty-first key.
   */
  async list(context: RequestContext, query: ListApiKeysQueryDto): Promise<ApiKeyListDto> {
    const page = await this.scopes.for(context).apiKeys.findPage({
      orderBy: { createdAt: 'desc' },
      take: query.limit,
      skip: query.offset,
    });
    const now = new Date();
    // One membership read for the whole page, not one per row: the page is
    // bounded by MAX_PAGE_SIZE and the ids are deduplicated, so this is a single
    // indexed `id IN (...)` however many keys one person minted.
    const roles = await this.issuerRoles(context, page.rows);
    return {
      data: page.rows.map((key) => toApiKeyDto(key, now, ApiKeysService.roleOf(key, roles))),
      has_more: page.hasMore,
      next_offset: page.nextSkip,
    };
  }

  async create(context: RequestContext, dto: CreateApiKeyDto): Promise<CreatedApiKeyDto> {
    const project = context.requireProject();
    const name = dto.name.trim();
    const expiresAt = ApiKeysService.parseExpiry(dto.expires_at);
    const scopes = ApiKeysService.resolveScopes(context, dto.scopes);
    await this.assertBelowCeiling(context);

    // The environment comes off the resolved project row, never off the body.
    const generated = generateApiKey(project.environment);
    ApiKeysService.assertContract(generated.key, project.environment);

    const id = newId('apiKey');
    const key = await this.scopes.for(context).apiKeys.create({
      id,
      name,
      keyHash: generated.keyHash,
      keyPrefix: generated.keyPrefix,
      environment: generated.environment,
      scopes,
      expiresAt,
      // PROVENANCE, off the resolved tenant context and never off the body.
      // `scopes` above is a snapshot of THIS caller's authority; these two
      // columns are what make that snapshot re-derivable afterwards, and
      // `effectiveScopes` intersects the stored scopes with whatever role the
      // membership carries at the time the key is used. There is no DTO field
      // that could set them, deliberately: a caller who could name the issuer
      // could mint a key attributed to an owner and keep owner authority
      // forever.
      createdByUserId: context.user.userId,
      createdByMembershipId: context.membershipId,
    });

    await this.audit.recordFor(context, {
      action: 'api_key.created',
      resourceType: 'api_key',
      resourceId: key.id,
      // Prefix, not key. The prefix identifies the credential in the log
      // without being one; `AuditService` would not have caught this for us,
      // because "key_prefix" does not look sensitive to its key-name filter.
      metadata: {
        name,
        key_prefix: key.keyPrefix,
        environment: key.environment,
        expires_at: expiresAt ? expiresAt.toISOString() : null,
        scopes,
        // WHO minted it and WITH WHAT AUTHORITY. The columns now carry the first
        // two; the ROLE AT MINT TIME is recorded nowhere else, and it is what an
        // operator compares against to see that the issuer has since been
        // demoted - the derivation only ever reports the CURRENT role.
        created_by_user_id: context.user.userId,
        created_by_membership_id: context.membershipId,
        created_by_role: context.role,
      },
    });

    // The one and only time the plaintext crosses a boundary. The issuer is the
    // caller, so no lookup is needed: their role is on the resolved context.
    return { ...toApiKeyDto(key, new Date(), context.role), key: generated.key };
  }

  /**
   * Revoke, idempotently.
   *
   * Idempotent because revocation is the thing an operator does under pressure,
   * often twice, sometimes from a script with retries: answering 409 to the
   * second call would make "is this key dead?" ambiguous at exactly the wrong
   * moment. A second call returns the same already-revoked key, keeps the
   * original `revoked_at` (which is the forensically interesting one) and files
   * no second audit entry.
   *
   * `requireById` first, so a key id from another tenant is a 404 that never
   * reaches an UPDATE.
   */
  async revoke(context: RequestContext, apiKeyId: string): Promise<ApiKeyDto> {
    const scope = this.scopes.for(context).apiKeys;
    const existing = await withCrossTenantNotFound(scope.requireById(apiKeyId));
    if (existing.revokedAt !== null) return this.present(context, existing);

    const revokedAt = new Date();
    let key: ApiKey;
    try {
      key = await withCrossTenantNotFound(scope.updateById(apiKeyId, { revokedAt }));
    } catch (err) {
      // A concurrent revoke is the only realistic way the row stops matching
      // between the read and the write. Report the outcome the caller wanted.
      const raced = await scope.findById(apiKeyId);
      if (raced?.revokedAt) return this.present(context, raced);
      throw err;
    }

    await this.audit.recordFor(context, {
      action: 'api_key.revoked',
      resourceType: 'api_key',
      resourceId: key.id,
      metadata: {
        name: key.name,
        key_prefix: key.keyPrefix,
        environment: key.environment,
        revoked_at: revokedAt.toISOString(),
      },
    });
    return this.present(context, key);
  }

  /**
   * One key, with its issuer's CURRENT role resolved.
   *
   * Kept separate from `toApiKeyDto` so the role lookup is a database read the
   * service owns rather than something a mapper does implicitly - and so the
   * mapper stays synchronous and total.
   */
  private async present(context: RequestContext, key: ApiKey): Promise<ApiKeyDto> {
    const roles = await this.issuerRoles(context, [key]);
    return toApiKeyDto(key, new Date(), ApiKeysService.roleOf(key, roles));
  }

  /**
   * `created_by_membership_id` -> the role that membership holds NOW.
   *
   * The read goes through the organization-scoped `members` repository, so a key
   * whose issuer membership somehow named another organization resolves to
   * nothing and the key reports no effective scopes - the fail-closed direction.
   *
   * Absent from the map means "issuer gone" and is NOT the same as an empty
   * scope list on the key: `effectiveScopes` turns it into the empty set, which
   * is exactly what the ON DELETE SET NULL on `api_keys.created_by_membership_id`
   * is there to signal.
   */
  private async issuerRoles(
    context: RequestContext,
    keys: readonly ApiKey[],
  ): Promise<ReadonlyMap<string, MemberRole>> {
    const ids = [
      ...new Set(
        keys
          .map((key) => key.createdByMembershipId)
          .filter((id): id is string => typeof id === 'string' && id.length > 0),
      ),
    ];
    if (ids.length === 0) return new Map();

    const members = await this.scopes.for(context).members.findMany({
      where: { id: { in: ids } },
      // Explicit, because `findMany` refuses an unbounded read - and bounded by
      // the page that produced these ids, so it cannot silently truncate.
      take: ids.length,
    });
    return new Map(members.map((member) => [member.id, member.role]));
  }

  private static roleOf(key: ApiKey, roles: ReadonlyMap<string, MemberRole>): MemberRole | null {
    if (!key.createdByMembershipId) return null;
    return roles.get(key.createdByMembershipId) ?? null;
  }

  /**
   * The per-project ceiling on live credentials.
   *
   * REVOKED KEYS DO NOT COUNT; EXPIRED ONES DO. That asymmetry is deliberate.
   *
   * A revoked key is retired - the row is kept forever so its delivery history
   * stays attributable - so counting it would make the ceiling a ratchet with no
   * operation available that frees a slot. Revocation IS that operation.
   *
   * Expiry is not counted as retirement because `status` is derived from two
   * timestamps at read time and is NOT a column (see `api-key-state.ts` and
   * `ListApiKeysQueryDto`). Excluding expired keys would mean a `now()`
   * comparison in SQL, which disagrees with the derivation by a request's worth
   * of clock and would make the ceiling move on its own with nobody touching
   * anything. An expired key is freed the same way a revoked one is: revoke it.
   *
   * Like the projects ceiling this is advisory under concurrency - two racing
   * creates can both pass - and for the same reason: it exists to stop runaway
   * automation, not to hold an exact invariant.
   */
  private async assertBelowCeiling(context: RequestContext): Promise<void> {
    const ceiling = maxApiKeysPerProject(this.config);
    const existing = await this.scopes.for(context).apiKeys.count({ revokedAt: null });
    if (existing < ceiling) return;

    // `limit_exceeded`, not `conflict`. The details were already here; the code
    // was not, so a ceiling and a uniqueness collision arrived as the same 409.
    throw new AppError(
      'limit_exceeded',
      `This project already holds ${existing} un-revoked API keys, which is its limit of ${ceiling}. Revoke a key you no longer need, or ask an operator to raise ${API_KEYS_PER_PROJECT.env}.`,
      { limit: ceiling, current: existing, resource: 'api_keys' },
    );
  }

  private static parseExpiry(value?: string): Date | null {
    if (value === undefined) return null;
    const expiresAt = new Date(value);
    if (Number.isNaN(expiresAt.getTime())) {
      throw new AppError('invalid_request', '"expires_at" must be an ISO-8601 timestamp.', {
        field: 'expires_at',
      });
    }
    // `<=` rather than `<`: the ingest path treats an expiry equal to now as
    // already expired, so a key created at its own expiry would be born dead.
    if (expiresAt.getTime() <= Date.now()) {
      throw new AppError('invalid_request', '"expires_at" must be in the future.', {
        field: 'expires_at',
      });
    }
    return expiresAt;
  }

  /**
   * A key may not be minted with authority its creator does not hold.
   *
   * `api-keys.write` is granted to `developer`, deliberately (issuing ingest
   * keys is the integration work). Without this check that grant would also be
   * a self-escalation: a developer could mint a key carrying `members.write` and
   * `billing.write` and hand it to whoever they liked. The permission answers
   * "may you create keys"; this answers "carrying what".
   *
   * This is still only a SNAPSHOT of the issuer's authority at one instant, and
   * a snapshot on its own was the security finding: a developer who minted a key
   * carrying `endpoints.write` and `events.replay`, and was then demoted to
   * viewer or removed from the organization entirely, left behind a credential
   * that still carried developer authority, because the key is bound to a
   * project and not to a human.
   *
   * What closes it is `effective-scopes.ts`: the key now records WHO minted it
   * (`created_by_user_id` / `created_by_membership_id`, written from the resolved
   * context in `create`), and every read intersects the stored scopes with the
   * permissions that membership holds NOW - the empty set once the membership is
   * gone. This function stays as the mint-time refusal: it keeps a key from ever
   * being BORN above its issuer, which the intersection alone would not, since a
   * scope that was never legitimately granted would come back the moment its
   * issuer was promoted. See HANDOFF.md, "API key effective scopes", for the
   * contract the Go ingest path adopts when it starts consulting scopes.
   */
  private static resolveScopes(context: RequestContext, requested?: string[]): Permission[] {
    if (!requested || requested.length === 0) return [];

    const scopes: Permission[] = [];
    for (const raw of requested) {
      const scope = raw.trim();
      if (!isPermission(scope)) {
        throw new AppError('invalid_request', `"${scope}" is not a known permission.`, {
          field: 'scopes',
          value: scope,
        });
      }
      if (!context.has(scope)) {
        // Same wording either way: a role that lacks the permission learns only
        // that it cannot grant it, not whether it exists in some other tier.
        throw new AppError(
          'forbidden',
          `You cannot issue a key with the scope "${scope}" because your role (${context.role}) does not hold it.`,
          { field: 'scopes', value: scope, role: context.role },
        );
      }
      if (!scopes.includes(scope)) scopes.push(scope);
    }
    return scopes;
  }

  /**
   * Belt and braces on the cross-process contract.
   *
   * `generateApiKey` is pinned by `common/api-key.spec.ts` against apikey.go,
   * so this should be unreachable - which is the point. If a future change to
   * the generator (a different alphabet, a shorter secret, a renamed scheme)
   * ever broke the shape the Go side validates, the failure mode without this
   * check is a database full of keys that authenticate nowhere, discovered by a
   * customer. With it, the create fails loudly at the first attempt.
   *
   * The key itself never appears in the message.
   */
  private static assertContract(key: string, environment: string): void {
    if (!isValidApiKeyShape(key)) {
      throw new AppError(
        'internal_error',
        'Generated API key does not satisfy the shared key shape (src/common/api-key.ts vs internal/ingest/apikey.go). Refusing to store a credential the ingest path would reject.',
      );
    }
    if (apiKeyEnvironment(key) !== environment) {
      throw new AppError(
        'internal_error',
        `Generated API key claims environment "${apiKeyEnvironment(key)}" but the project is "${environment}".`,
      );
    }
  }
}
