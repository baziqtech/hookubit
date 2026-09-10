/**
 * Explicit first-owner bootstrap.
 *
 * There is deliberately NO default account. Convoy's community build silently
 * creates superuser@default.com/default on first start against an empty users
 * table; that is a shipped-credential vulnerability, not a convenience. This
 * command requires real values, refuses to run twice, and exits non-zero with a
 * readable message on any failure rather than leaving a half-created org.
 *
 * Usage:
 *   BOOTSTRAP_EMAIL=... BOOTSTRAP_PASSWORD=... BOOTSTRAP_ORG="Acme" \
 *     pnpm --filter @hookubit/control-api bootstrap
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { newId } from '../common/ids';
import { PasswordService } from '../auth/password.service';

/**
 * Arbitrary but fixed. Two concurrent bootstraps must contend on the SAME
 * advisory lock key or the guard does nothing.
 */
export const BOOTSTRAP_ADVISORY_LOCK_KEY = 8_244_071_509_311_002n;

export interface BootstrapInput {
  email: string;
  password: string;
  orgName: string;
}

export const MIN_BOOTSTRAP_PASSWORD_LENGTH = 12;

/**
 * `organizations.slug` is NOT NULL and globally unique, and a name made
 * entirely of punctuation ("!!!") slugifies to the empty string - which would
 * be accepted once and then collide with every other punctuation-only name.
 * Reject it here with a message that says what to do.
 */
export function slugifyOrgName(orgName: string): string {
  const slug = orgName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  if (!slug) {
    throw new Error(
      `BOOTSTRAP_ORG "${orgName}" contains no letters or digits, so it has no usable slug. ` +
        'Use a name with at least one alphanumeric character.',
    );
  }
  return slug;
}

export function readBootstrapInput(env: NodeJS.ProcessEnv): BootstrapInput {
  const missing = [
    !env.BOOTSTRAP_EMAIL && 'BOOTSTRAP_EMAIL',
    !env.BOOTSTRAP_PASSWORD && 'BOOTSTRAP_PASSWORD',
    !env.BOOTSTRAP_ORG && 'BOOTSTRAP_ORG',
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(`Missing required variables: ${missing.join(', ')}`);
  }
  const password = env.BOOTSTRAP_PASSWORD as string;
  if (password.length < MIN_BOOTSTRAP_PASSWORD_LENGTH) {
    throw new Error(
      `BOOTSTRAP_PASSWORD must be at least ${MIN_BOOTSTRAP_PASSWORD_LENGTH} characters`,
    );
  }
  return {
    email: (env.BOOTSTRAP_EMAIL as string).toLowerCase(),
    password,
    orgName: env.BOOTSTRAP_ORG as string,
  };
}

/**
 * Creates the first owner, their organization and the owner membership, or
 * nothing at all.
 *
 * Two things this deliberately does NOT do:
 *
 *  - It does not count users outside the transaction. READ COMMITTED would not
 *    serialise that check anyway, so two concurrent invocations both saw an
 *    empty table and both created an organization. The count now happens after
 *    `pg_advisory_xact_lock`, which is held until the transaction ends, so the
 *    second invocation blocks, then sees the first one's committed row and
 *    refuses.
 *  - It does not hash inside the transaction. Argon2 at OWASP parameters takes
 *    long enough that holding a connection for it hits Prisma's 5s interactive
 *    transaction timeout and surfaces as an opaque P2028 rather than anything
 *    an operator can act on. Hash first, then open the transaction.
 */
export async function runBootstrap(
  prisma: Pick<PrismaClient, '$transaction'>,
  input: BootstrapInput,
  passwords: Pick<PasswordService, 'hash'> = new PasswordService(),
): Promise<{ organizationId: string; userId: string; slug: string }> {
  const slug = slugifyOrgName(input.orgName);
  const passwordHash = await passwords.hash(input.password);

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // Session-scoped mutual exclusion, released on COMMIT or ROLLBACK.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${BOOTSTRAP_ADVISORY_LOCK_KEY}::bigint)`;

    const existing = await tx.user.count();
    if (existing > 0) {
      throw new Error(
        `Refusing to bootstrap: the users table already has ${existing} row(s). ` +
          'Create further users through the application.',
      );
    }

    const org = await tx.organization.create({
      data: { id: newId('organization'), name: input.orgName, slug },
    });
    const user = await tx.user.create({
      data: {
        id: newId('user'),
        email: input.email,
        passwordHash,
        emailVerifiedAt: new Date(),
      },
    });
    await tx.organizationMember.create({
      data: {
        id: newId('member'),
        organizationId: org.id,
        userId: user.id,
        role: 'owner',
      },
    });
    await tx.auditLog.create({
      data: {
        id: newId('auditLog'),
        organizationId: org.id,
        userId: user.id,
        action: 'organization.bootstrapped',
        resourceType: 'organization',
        resourceId: org.id,
      },
    });

    return { organizationId: org.id, userId: user.id, slug };
  });
}

async function main(): Promise<void> {
  const input = readBootstrapInput(process.env);
  // Fail on an unusable org name before opening a database connection.
  slugifyOrgName(input.orgName);

  const prisma = new PrismaClient();
  try {
    await runBootstrap(prisma, input);
    process.stdout.write(
      `Bootstrapped organization "${input.orgName}" with owner ${input.email}\n`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    process.stderr.write(`bootstrap failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
