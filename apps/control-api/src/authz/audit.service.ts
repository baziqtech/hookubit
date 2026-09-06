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
 * Keys whose values must never reach the audit table. Matched case-insensitively
 * against the key name. `*_id`/`*Id` are exempt because `api_key_id` and
 * `endpoint_secret_id` are references, not secrets, and losing them would make
 * the log useless for the thing it exists to answer.
 */
const SENSITIVE_KEY = /(secret|password|passwd|token|credential|authorization|signature|api_?key)/i;
const REFERENCE_KEY = /(_id|Id)$/;

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
   * Record a privileged action against a tenant.
   *
   * @param client pass the `$transaction` client to make this atomic with the
   *               change being audited.
   */
  async record(
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
    return this.record(
      context.organization.id,
      {
        userId: context.user.userId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
      },
      // The project a privileged action happened in is part of the fact, and
      // `audit_logs` has no project_id column, so it goes in the metadata.
      context.project
        ? {
            ...entry,
            metadata: { project_id: context.project.id, ...(entry.metadata ?? {}) },
          }
        : entry,
      client,
    );
  }

  /**
   * Drop values whose key looks like a credential.
   *
   * Audit metadata is written by fourteen modules and read by whoever is
   * debugging at 2am; sooner or later someone will spread a whole DTO into it.
   * A key-name filter does not catch a secret stored under an innocent name, so
   * it is a backstop, not a licence - do not put secrets in here.
   */
  private static sanitise(
    metadata: Record<string, unknown> | undefined,
  ): Prisma.InputJsonValue | typeof Prisma.DbNull {
    // DbNull, not JsonNull: the column should be SQL NULL when there is nothing
    // to say, not the JSON value `null`, which reads back as a present-but-null
    // field and would make "was any metadata recorded?" unanswerable.
    if (!metadata) return Prisma.DbNull;
    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(metadata)) {
      safe[key] =
        SENSITIVE_KEY.test(key) && !REFERENCE_KEY.test(key) ? '[redacted]' : value;
    }
    return safe as Prisma.InputJsonValue;
  }
}
