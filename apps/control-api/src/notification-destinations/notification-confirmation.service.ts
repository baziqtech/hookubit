import { Injectable } from '@nestjs/common';
import { NotificationStatus } from '@prisma/client';
import { createHash } from 'node:crypto';
import { AppError } from '../common/errors';
// The unscoped client, deliberately. See the class docblock; this ONE FILE is
// allowlisted in .eslintrc.json alongside the auth and organization files that
// have the same property.
import { PrismaService } from '../infrastructure/prisma/prisma.service';

/**
 * Redeeming a notification-confirmation link.
 *
 * ## Why this is unauthenticated, and therefore unscoped
 *
 * The person who can read `oncall@example.com` is very often not a member of
 * the organization that added it — that is the entire point of using a group
 * address. Requiring them to sign in would make the feature unusable for the
 * case it exists for, and requiring the ADDER to confirm would defeat it
 * completely: the whole purpose is that somebody who can read the address has
 * agreed.
 *
 * So possession of the token is the authority. That is why it is 32 random
 * bytes, stored only as a SHA-256 hash, single-use, and expiring — the same
 * properties `user_tokens` has, for the same reason, and this does not reuse
 * that table only because it is keyed by user and this subject has no account.
 *
 * It is its own service and its own allowlist entry so the tenant-scoped half
 * of this feature cannot quietly acquire an unscoped client alongside it.
 */
@Injectable()
export class NotificationConfirmationService {
  constructor(private readonly prisma: PrismaService) {}

  async confirm(rawToken: string): Promise<{ project_name: string; target: string }> {
    /*
     * ONE message for "no such token", "already used" and "expired".
     *
     * This endpoint is reachable by anyone, so distinguishing them is an oracle
     * for which tokens exist. There is also nothing a reader could do
     * differently with the distinction: every one of the three is fixed by
     * asking for a new link.
     *
     * `invalid_request`, NOT `not_found`. The 404 vocabulary in this codebase
     * is reserved for one thing — answering "does this exist for you?" across
     * a tenant boundary — and every such answer is required to use
     * CROSS_TENANT_MESSAGE verbatim, which a test enforces across the whole
     * source tree. This is not that answer: there is no tenant here and nothing
     * to disclose, so borrowing the 404 would put a second dialect into a
     * vocabulary whose value is that it has exactly one.
     */
    const invalid = new AppError(
      'invalid_request',
      'This confirmation link is not valid. It may have already been used, or it may have expired — ask for a new one from the project’s Notifications page.',
    );

    const hash = createHash('sha256').update(rawToken).digest('hex');
    const destination = await this.prisma.notificationDestination.findUnique({
      where: { confirmationTokenHash: hash },
      include: { project: { select: { name: true } } },
    });
    if (!destination) throw invalid;
    if (destination.confirmationExpiresAt && destination.confirmationExpiresAt <= new Date()) {
      throw invalid;
    }

    await this.prisma.notificationDestination.update({
      where: { id: destination.id },
      data: {
        status: NotificationStatus.confirmed,
        confirmedAt: new Date(),
        // Consumed whether or not the row was already confirmed, so a link
        // forwarded on cannot be replayed.
        confirmationTokenHash: null,
        confirmationExpiresAt: null,
      },
    });

    return { project_name: destination.project.name, target: destination.target };
  }
}
