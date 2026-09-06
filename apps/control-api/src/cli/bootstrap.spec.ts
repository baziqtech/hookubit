import { FakePrisma } from '../auth/testing/prisma.fake';
import { PrismaClient } from '@prisma/client';
import {
  BOOTSTRAP_ADVISORY_LOCK_KEY,
  readBootstrapInput,
  runBootstrap,
  slugifyOrgName,
} from './bootstrap';

const INPUT = { email: 'ada@example.com', password: 'a long enough password', orgName: 'Acme Ltd' };

function asClient(prisma: FakePrisma): Pick<PrismaClient, '$transaction'> {
  return prisma as unknown as Pick<PrismaClient, '$transaction'>;
}

/** Records when hashing happened relative to the transaction opening. */
class OrderRecorder {
  readonly events: string[] = [];
  async hash(plaintext: string): Promise<string> {
    this.events.push(`hash:${plaintext.length}`);
    return '$argon2id$fake';
  }
}

describe('slugifyOrgName (FIX 7)', () => {
  it('slugifies a normal name', () => {
    expect(slugifyOrgName('Acme Ltd')).toBe('acme-ltd');
    expect(slugifyOrgName('  ShaQ Express!  ')).toBe('shaq-express');
  });

  it('REGRESSION: rejects a name that yields an empty slug', () => {
    // organizations.slug is NOT NULL and globally unique; "" would be taken
    // once and then collide with every other punctuation-only name.
    for (const name of ['!!!', '---', '   ', '###@@@']) {
      expect(() => slugifyOrgName(name)).toThrow(/no usable slug/);
    }
  });
});

describe('readBootstrapInput', () => {
  it('names every missing variable at once', () => {
    expect(() => readBootstrapInput({})).toThrow(
      /BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD, BOOTSTRAP_ORG/,
    );
  });

  it('enforces a minimum password length and lowercases the email', () => {
    expect(() =>
      readBootstrapInput({ BOOTSTRAP_EMAIL: 'a@b.co', BOOTSTRAP_PASSWORD: 'short', BOOTSTRAP_ORG: 'x' }),
    ).toThrow(/at least 12 characters/);

    expect(
      readBootstrapInput({
        BOOTSTRAP_EMAIL: 'Ada@Example.COM',
        BOOTSTRAP_PASSWORD: 'a long enough password',
        BOOTSTRAP_ORG: 'Acme',
      }).email,
    ).toBe('ada@example.com');
  });
});

describe('runBootstrap (FIX 7)', () => {
  it('creates owner, organization, membership and an audit row', async () => {
    const prisma = new FakePrisma();

    const result = await runBootstrap(asClient(prisma), INPUT);

    expect(prisma.users.size).toBe(1);
    expect(prisma.organizations.size).toBe(1);
    expect([...prisma.members.values()][0].role).toBe('owner');
    expect(prisma.auditLogs[0].action).toBe('organization.bootstrapped');
    expect(result.slug).toBe('acme-ltd');
  });

  it('REGRESSION: takes the advisory lock BEFORE counting users', async () => {
    const prisma = new FakePrisma();
    const order: string[] = [];
    const originalCount = prisma.user.count;
    prisma.user.count = async () => {
      order.push('count');
      return originalCount();
    };
    const originalRaw = prisma.$executeRaw.bind(prisma);
    prisma.$executeRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      order.push('lock');
      return originalRaw(strings, ...values);
    };

    await runBootstrap(asClient(prisma), INPUT);

    // The count used to sit outside the transaction entirely, where READ
    // COMMITTED would not serialise it and two invocations both saw an empty
    // table.
    expect(order).toEqual(['lock', 'count']);
    expect(prisma.rawStatements[0]).toContain('pg_advisory_xact_lock');
    expect(prisma.rawStatements[0]).toContain(String(BOOTSTRAP_ADVISORY_LOCK_KEY));
  });

  it('REGRESSION: hashes the password OUTSIDE the interactive transaction', async () => {
    const prisma = new FakePrisma();
    const recorder = new OrderRecorder();
    const originalTx = prisma.$transaction.bind(prisma);
    prisma.$transaction = async <T>(fn: (tx: FakePrisma) => Promise<T>): Promise<T> => {
      recorder.events.push('tx:begin');
      const out = await originalTx(fn);
      recorder.events.push('tx:commit');
      return out;
    };

    await runBootstrap(asClient(prisma), INPUT, recorder);

    // Argon2 at hardened parameters inside an interactive transaction blows
    // Prisma's 5s timeout and surfaces as an opaque P2028.
    expect(recorder.events).toEqual([`hash:${INPUT.password.length}`, 'tx:begin', 'tx:commit']);
  });

  it('refuses to run a second time', async () => {
    const prisma = new FakePrisma();
    await runBootstrap(asClient(prisma), INPUT);

    await expect(
      runBootstrap(asClient(prisma), { ...INPUT, email: 'bob@example.com' }),
    ).rejects.toThrow(/already has 1 row/);

    expect(prisma.users.size).toBe(1);
    expect(prisma.organizations.size).toBe(1);
  });

  it('rejects an unusable org name before writing anything', async () => {
    const prisma = new FakePrisma();

    await expect(runBootstrap(asClient(prisma), { ...INPUT, orgName: '!!!' })).rejects.toThrow(
      /no usable slug/,
    );

    expect(prisma.organizations.size).toBe(0);
    expect(prisma.users.size).toBe(0);
  });

  it('never stores the password in the clear', async () => {
    const prisma = new FakePrisma();
    await runBootstrap(asClient(prisma), INPUT);

    const stored = [...prisma.users.values()][0];
    expect(stored.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(stored.passwordHash).not.toContain(INPUT.password);
  });
});
