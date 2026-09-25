import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { newId } from '../common/ids';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { RequestContext } from './tenant-context';
import { TenantClient } from './tenant-scope.factory';

/**
 * `<resource>.<verb>`, past tense: `endpoint.created`, `member.role_changed`,
 * `api_key.revoked`, `delivery.replayed`. The template type is a nudge, not a
 * closed set - a closed enum would have to be edited by every module and would
 * be the first thing someone works around.
 */
export type AuditAction = `${string}.${string}`;

export interface AuditEntry {
  action: AuditAction;
  /** `endpoint`, `api_key`, `member`, `project`, ... */
  resourceType: string;
  resourceId?: string | null;
  /**
   * What changed, enough to answer "who did this and what did it look like
   * before?". Never secrets - see the redaction note on `sanitise`.
   */
  metadata?: Record<string, unknown>;
}

export interface AuditActor {
  userId?: string | null;
  /** Set instead of `userId` when the actor was an API key. */
  apiKeyId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/** The slice of a Prisma client this service uses. */
interface AuditLogWriter {
  auditLog: {
    create(args: { data: Prisma.AuditLogUncheckedCreateInput }): Promise<{ id: string }>;
  };
}

/**
 * WHAT COUNTS AS A CREDENTIAL KEY - the rule, not a list of exceptions.
 *
 * This was a bare substring match
 * (`/(secret|password|token|credential|authorization|signature|api[-_]?key)/i`
 * minus a `_id`/`Id` escape hatch) and it over-redacted every key that merely
 * CONTAINED one of those words. `previous_secrets_expire_at` - a timestamp, and
 * the single fact the `endpoint_secret.rotated` row is consulted for ("when did
 * the old secret stop signing?") - came back as `[redacted]`. The author worked
 * around it by renaming the key, and the same trap caught the next key they
 * added. A rule that has to be worked around one key at a time is the bug.
 *
 * So the question the rule asks is "could this key's VALUE be a credential?",
 * answered on whole words rather than substrings:
 *
 *  1. The key is split into words (`_`, `-`, `.`, and camelCase boundaries), so
 *     `signingSecret`, `signing_secret` and `x-api-key` are one shape.
 *  2. A TERMINAL word that marks the value as non-secret metadata - `_at`,
 *     `_id`/`Id`, `_ids`, `_count`, `_version`, `_prefix` - wins outright. A
 *     timestamp, a row reference, a tally, a version number and a displayable
 *     prefix are none of them credentials, whatever the rest of the name says.
 *     This is what keeps `previous_secrets_expire_at`, `secret_version`,
 *     `key_prefix` and `endpoint_secret_id` readable.
 *  3. Otherwise: a credential WORD anywhere (`secret`, `password`, `token`,
 *     `credential`, `authorization`, `signature`, ...) redacts; so does a
 *     terminal `key`/`keys` (the bare `key` field IS the plaintext), and a
 *     qualified key such as `api_key`, `private_key`, `signing_key_hash`.
 *
 * Note what stays readable and what does not: `awaiting_key_handover` is a flag
 * whose name happens to mention a key and is kept; `api_key` is the key and is
 * not. A false negative here writes a live secret into a table every
 * `audit.read` holder can query, so anything genuinely ambiguous still redacts -
 * `signature_algorithm` and `secret_value` both go, and that is the intended
 * direction.
 *
 * This is still a key-name filter and therefore still a backstop, not a licence:
 * a secret stored under an innocent name is not caught by anything here.
 */
const CREDENTIAL_WORDS: ReadonlySet<string> = new Set([
  'secret',
  'secrets',
  'password',
  'passwords',
  'passwd',
  'passphrase',
  'pwd',
  'token',
  'tokens',
  'credential',
  'credentials',
  'authorization',
  'authorisation',
  'signature',
  'signatures',
  'apikey',
  'apikeys',
  'bearer',
  'otp',
]);

/**
 * Words that, as the LAST word of a key, say the value is metadata about a
 * credential rather than one. Deliberately short: every entry is a shape that
 * cannot hold key material, and a longer list is how a real secret gets through.
 */
const NON_SECRET_TERMINAL: ReadonlySet<string> = new Set([
  'at', // *_at - a timestamp
  'id', // *_id / *Id - a row reference
  'ids',
  'count',
  'version',
  'prefix', // api_keys.key_prefix, displayable by design
]);

/**
 * Words that describe a DERIVATION of the value rather than a different kind of
 * value, and are stripped before the rule is applied: `key_hash` is decided as
 * `key`, `secret_value` as `secret`. Without this a stored `key_hash` - which is
 * the exact value the ingest path authenticates by - reads as innocuous.
 */
const TRANSPARENT_SUFFIX: ReadonlySet<string> = new Set([
  'hash',
  'hashes',
  'digest',
  'value',
  'values',
  'plaintext',
  'raw',
]);

/** Qualifiers that turn a following `key`/`keys` word into a credential. */
const KEY_QUALIFIERS: ReadonlySet<string> = new Set([
  'api',
  'private',
  'public',
  'secret',
  'signing',
  'access',
  'encryption',
  'session',
  'client',
  'master',
  'shared',
  'webhook',
]);

/** `signingSecret` -> ['signing', 'secret']; `x-api-key` -> ['x','api','key']. */
function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
}

/**
 * True when this metadata key's value could plausibly BE a credential.
 *
 * Exported so the rule can be tested in both directions directly, and so a
 * module that is about to name a metadata field can check it rather than
 * discovering the answer in a redacted audit row weeks later.
 */
export function isCredentialKey(key: string): boolean {
  const words = keyWords(key);
  if (words.length === 0) return false;

  // `key_hash` is a key; `secret_value` is a secret. Never strip the last word
  // standing, or a field literally called `hash` would decide on nothing.
  while (words.length > 1 && TRANSPARENT_SUFFIX.has(words[words.length - 1])) words.pop();

  const last = words[words.length - 1];
  if (NON_SECRET_TERMINAL.has(last)) return false;

  if (words.some((word) => CREDENTIAL_WORDS.has(word))) return true;
  if (last === 'key' || last === 'keys') return true;
  return words.some(
    (word, index) =>
      KEY_QUALIFIERS.has(word) && (words[index + 1] === 'key' || words[index + 1] === 'keys'),
  );
}

export const REDACTED = '[redacted]';
export const TRUNCATED = '[truncated]';

/**
 * The audit hook (schema: `audit_logs`).
 *
 * One place, so fourteen modules do not each invent an id scheme, an actor
 * shape and a redaction policy. Deliberately NOT an interceptor or a decorator:
 * an automatic "log every mutating request" layer records HTTP verbs, not
 * business facts, and cannot know the resource id of something it just created.
 * Call it from the service, where the fact is known.
 *
 * **Call it inside the action's transaction.** `record` takes an optional
 * client so the audit row commits or rolls back with the change it describes;
 * an audit row for a change that never landed is worse than no row. It throws
 * on failure for the same reason - a swallowed write here is a silent hole in
 * the record.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The actual write. PRIVATE on purpose.
   *
   * It takes a free-form `organizationId`, so as an exported method it let any
   * caller file an audit row against any organization - including one it had no
   * membership in - and pick the actor it was attributed to. Everything
   * controller-driven goes through `recordFor`, where all three come off the
   * resolved tenant context and none of them can be stated by the caller.
   *
   * `AuditActor.apiKeyId` stays on the type for the day an API-key principal
   * carries a resolved context; there is no path that sets it from the wire.
   *
   * @param client pass the `$transaction` client to make this atomic with the
   *               change being audited.
   */
  private async write(
    organizationId: string,
    actor: AuditActor,
    entry: AuditEntry,
    client?: TenantClient,
  ): Promise<string> {
    const id = newId('auditLog');
    const writer = (client ?? this.prisma) as unknown as AuditLogWriter;
    await writer.auditLog.create({
      data: {
        id,
        organizationId,
        userId: actor.userId ?? null,
        apiKeyId: actor.apiKeyId ?? null,
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId ?? null,
        metadata: AuditService.sanitise(entry.metadata),
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      },
    });
    return id;
  }

  /**
   * The form a controller-driven action should use: actor, organization, IP and
   * user agent all come off the resolved tenant context, so they cannot be
   * mis-stated and cannot be forged by the caller.
   */
  async recordFor(
    context: RequestContext,
    entry: AuditEntry,
    client?: TenantClient,
  ): Promise<string> {
    return this.write(
      context.organization.id,
      {
        userId: context.user.userId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
      },
      // The project a privileged action happened in is part of the fact, and
      // `audit_logs` has no project_id column, so it goes in the metadata.
      //
      // The resolved id goes AFTER the spread. Before, caller metadata won, so
      // a `project_id` key anywhere in a spread DTO overwrote the resolved one
      // and the log recorded an action against a project it did not happen in -
      // forgeable by the caller, and invisible afterwards.
      context.project
        ? {
            ...entry,
            metadata: { ...(entry.metadata ?? {}), project_id: context.project.id },
          }
        : entry,
      client,
    );
  }

  /**
   * The form a PLATFORM-INITIATED action must use: no user, no API key, no IP,
   * no user agent, because there was no request and inventing one would put a
   * human's name on something a background job did.
   *
   * It exists for exactly one shape of caller - a periodic sweep that acts on a
   * customer's resource without a customer asking - and the endpoint
   * auto-disable in `src/maintenance` is currently the only one. That is the
   * shape `write`'s docblock refuses to expose generally, so the two guard rails
   * `recordFor` gets from the tenant context have to be replaced by discipline
   * here, and both are stated as obligations on the caller rather than
   * pretended away:
   *
   *  1. **`organizationId` must be DERIVED from the resource's own ownership
   *     chain** - endpoint -> project -> organization, read in the same
   *     transaction as the change - and never from anything a request could
   *     reach. There is no tenant context to check it against.
   *  2. **Pass the transaction client.** The audit row is the only thing that
   *     tells a customer their endpoint was switched off; a change that commits
   *     without its audit row is a silent disable, which is the support ticket
   *     this whole path exists to avoid.
   *
   * The actor columns are written NULL rather than a sentinel string like
   * 'system'. `user_id` is a foreign key to `users` and a sentinel would either
   * violate it or require a fake user row that someone could later authenticate
   * as; NULL is already the schema's way of saying "no user did this", and the
   * action name says who did.
   */
  async recordSystem(
    organizationId: string,
    entry: AuditEntry,
    client?: TenantClient,
  ): Promise<string> {
    return this.write(organizationId, {}, entry, client);
  }

  /**
   * Drop values whose key looks like a credential, at EVERY depth.
   *
   * Audit metadata is written by fourteen modules and read by whoever is
   * debugging at 2am; sooner or later someone spreads a whole DTO into it. A
   * top-level-only walk copied nested objects and arrays by reference, so
   * `{ endpoint: { signing_secret: '...' } }` landed in `audit_logs.metadata`
   * in plaintext - a table every `audit.read` holder can query.
   *
   * A key-name filter still does not catch a secret stored under an innocent
   * name, so it is a backstop, not a licence - do not put secrets in here.
   */
  private static sanitise(
    metadata: Record<string, unknown> | undefined,
  ): Prisma.InputJsonValue | typeof Prisma.DbNull {
    // DbNull, not JsonNull: the column should be SQL NULL when there is nothing
    // to say, not the JSON value `null`, which reads back as a present-but-null
    // field and would make "was any metadata recorded?" unanswerable.
    if (!metadata) return Prisma.DbNull;
    return AuditService.redactObject(metadata, 0) as Prisma.InputJsonValue;
  }

  /**
   * Deep enough for the nesting a real DTO has, shallow enough that a cyclic or
   * pathological object cannot turn one audit write into a stack overflow. A
   * cycle is cut by the same cap, so no `seen` set is needed.
   */
  private static readonly MAX_METADATA_DEPTH = 6;

  private static redactObject(value: Record<string, unknown>, depth: number): unknown {
    const safe: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      safe[key] = isCredentialKey(key)
        ? REDACTED
        : AuditService.redactValue(nested, depth + 1);
    }
    return safe;
  }

  private static redactValue(value: unknown, depth: number): unknown {
    if (value === null || typeof value !== 'object') return value;
    if (value instanceof Date) return value.toISOString();
    // Binary is never something the log needs and is very often key material.
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return '[binary]';
    if (depth >= AuditService.MAX_METADATA_DEPTH) return TRUNCATED;
    if (Array.isArray(value)) {
      return value.map((item) => AuditService.redactValue(item, depth + 1));
    }
    // Own enumerable keys, so a class instance spread into metadata is walked
    // exactly like the plain object it will be serialised as.
    return AuditService.redactObject(value as Record<string, unknown>, depth);
  }
}
