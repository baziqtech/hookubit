import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiKey } from '@prisma/client';
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
    return {
      data: page.rows.map((key) => toApiKeyDto(key, now)),
      count: page.rows.length,
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
        // WHO minted it and WITH WHAT AUTHORITY. `api_keys` has no
        // `created_by_user_id` column yet (HANDOFF.md carries the migration), so
        // until it does this audit row is the only record tying a credential's
        // scopes back to a human and to the role those scopes were copied from.
        // The actor columns already carry the user id; the ROLE is not recorded
        // anywhere else, and it is precisely what a later re-derivation
        // (`key.scopes INTERSECT permissionsForRole(current role)`) has to
        // compare against to notice that the issuer has since been demoted.
        created_by_user_id: context.user.userId,
        created_by_membership_id: context.membershipId,
        created_by_role: context.role,
      },
    });

    // The one and only time the plaintext crosses a boundary.
    return { ...toApiKeyDto(key), key: generated.key };
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
    if (existing.revokedAt !== null) return toApiKeyDto(existing);

    const revokedAt = new Date();
    let key: ApiKey;
    try {
      key = await withCrossTenantNotFound(scope.updateById(apiKeyId, { revokedAt }));
    } catch (err) {
      // A concurrent revoke is the only realistic way the row stops matching
      // between the read and the write. Report the outcome the caller wanted.
      const raced = await scope.findById(apiKeyId);
      if (raced?.revokedAt) return toApiKeyDto(raced);
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
    return toApiKeyDto(key);
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

    throw new AppError(
      'conflict',
      `This project already holds ${existing} un-revoked API keys, which is its limit of ${ceiling}. Revoke a key you no longer need, or ask an operator to raise ${API_KEYS_PER_PROJECT.env}.`,
      { limit: ceiling, current: existing },
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
   * KNOWN LIMIT, and the reason `created_by_*` is in the audit metadata above:
   * this is a SNAPSHOT of the issuer's authority at one instant, and nothing
   * re-checks it afterwards. A developer who mints a key carrying
   * `endpoints.write` and `events.replay`, and is then demoted to viewer or
   * removed from the organization entirely, leaves behind a credential that
   * still carries developer authority - because the key is bound to a project,
   * not to a human, and `api_keys` has no `created_by_user_id` column to bind it
   * to one. It is latent rather than live only because the ingest path does not
   * consult `scopes` at all today (`internal/ingest/handler.go` authenticates on
   * the key, its project and its environment); the first key-authenticated
   * control route makes it real. HANDOFF.md carries the migration and the
   * enforcement this needs, and closing it requires that schema change.
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
