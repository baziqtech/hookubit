import { Prisma } from '@prisma/client';
import { AuditService, RequestContext, TenantScopeFactory } from '../authz';
import { AppError } from '../common/errors';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { TenantTransactionRunner, isSerializationFailure } from './tenant-transaction';
import { FakeWorld, IDS, contextFor, seedWorld } from './testing/world';

/**
 * The RUNNER's own contract, as opposed to the invariants it protects.
 *
 * The property tests ("an owner survives two concurrent demotions") live in
 * `members.service.spec.ts`, where the invariant lives. What is asserted here is
 * the mechanism those tests depend on and that a fake cannot reproduce: the
 * isolation level actually reaches PostgreSQL, a serialisation abort is retried
 * rather than surfaced, and an exhausted retry budget is a 409 rather than a
 * 500.
 */
describe('TenantTransactionRunner', () => {
  let db: FakeWorld;
  let context: RequestContext;

  beforeEach(async () => {
    db = seedWorld();
    context = await contextFor(db, IDS.ownerA, IDS.orgA);
  });

  const runnerOver = (
    prisma: PrismaService,
  ): TenantTransactionRunner =>
    new TenantTransactionRunner(
      prisma,
      new TenantScopeFactory(prisma),
      new AuditService(prisma),
    );

  /**
   * A client that records the options it was handed and can be told to fail a
   * number of times first.
   */
  class RecordingPrisma {
    readonly options: Array<Record<string, unknown> | undefined> = [];
    calls = 0;

    constructor(private readonly failures: () => Error | null) {}

    async $transaction<T>(
      fn: (tx: unknown) => Promise<T>,
      options?: Record<string, unknown>,
    ): Promise<T> {
      this.calls += 1;
      this.options.push(options);
      const failure = this.failures();
      if (failure) throw failure;
      return fn(this);
    }

    asPrisma(): PrismaService {
      return this as unknown as PrismaService;
    }
  }

  const serializationFailure = (): Error => {
    const err = new Error('write conflict') as Error & { code: string };
    err.code = 'P2034';
    return err;
  };

  it('runs at SERIALIZABLE, not at the READ COMMITTED default', async () => {
    // The whole last-owner fix rests on this one argument reaching the driver:
    // two concurrent demotions of DIFFERENT rows take no conflicting row lock,
    // so nothing below SERIALIZABLE stops them both committing.
    const prisma = new RecordingPrisma(() => null);
    await runnerOver(prisma.asPrisma()).run(context, async () => 'done');

    expect(prisma.options[0]).toEqual({
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
  });

  it('retries a serialisation failure instead of surfacing it', async () => {
    let remaining = 2;
    const prisma = new RecordingPrisma(() =>
      remaining-- > 0 ? serializationFailure() : null,
    );

    await expect(runnerOver(prisma.asPrisma()).run(context, async () => 'done')).resolves.toBe(
      'done',
    );
    expect(prisma.calls).toBe(3);
  });

  it('retries a raw 40001 reported only in the message', async () => {
    let remaining = 1;
    const prisma = new RecordingPrisma(() =>
      remaining-- > 0
        ? new Error('could not serialize access due to read/write dependencies among transactions')
        : null,
    );

    await expect(runnerOver(prisma.asPrisma()).run(context, async () => 'ok')).resolves.toBe('ok');
    expect(prisma.calls).toBe(2);
  });

  it('answers 409, not 500, when the retries are exhausted', async () => {
    // Nothing landed and nothing is inconsistent - "try again" is the honest
    // answer, and a 500 would page somebody for a working system under load.
    const prisma = new RecordingPrisma(() => serializationFailure());
    const runner = runnerOver(prisma.asPrisma());

    await expect(runner.run(context, async () => 'never')).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(prisma.calls).toBe(4);
  });

  it('does not retry an ordinary failure, and does not launder it into a conflict', async () => {
    const prisma = new RecordingPrisma(() => null);
    const runner = runnerOver(prisma.asPrisma());

    await expect(
      runner.run(context, async () => {
        throw new AppError('forbidden', 'the lattice refused this');
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(prisma.calls).toBe(1);
  });

  it('hands the callback an audit handle, never the raw transaction client', async () => {
    // The regression this closes: the second argument used to be
    // `Prisma.TransactionClient`, which exposes every model delegate with no
    // tenant predicate. A callback could write
    // `tx.organizationMember.updateMany({ where: {}, data: { role: 'owner' } })`
    // and pass lint - the eslint fence bans IMPORTING the unscoped client, not
    // receiving one as an argument.
    const runner = runnerOver(db.asPrisma());
    const handed = await runner.run(context, async (_scope, audit) => audit);

    expect(Object.keys(handed)).toEqual(['record']);
    expect((handed as unknown as Record<string, unknown>).organizationMember).toBeUndefined();
    expect((handed as unknown as Record<string, unknown>).organization).toBeUndefined();
  });

  it('writes the audit row inside the transaction, attributed to the resolved context', async () => {
    const runner = runnerOver(db.asPrisma());
    await runner.run(context, async (_scope, audit) => {
      await audit.record({ action: 'member.removed', resourceType: 'member', resourceId: 'mem_x' });
    });

    expect(db.all('auditLog')).toContainEqual(
      expect.objectContaining({
        action: 'member.removed',
        organizationId: IDS.orgA,
        userId: IDS.ownerA,
      }),
    );
  });

  it('rolls the audit row back with the work it describes', async () => {
    const runner = runnerOver(db.asPrisma());
    const before = db.all('auditLog').length;

    await expect(
      runner.run(context, async (_scope, audit) => {
        await audit.record({ action: 'member.removed', resourceType: 'member' });
        throw new Error('the write after it failed');
      }),
    ).rejects.toThrow('the write after it failed');

    expect(db.all('auditLog')).toHaveLength(before);
  });

  describe('isSerializationFailure', () => {
    it('recognises every shape Prisma reports one in', () => {
      expect(isSerializationFailure({ code: 'P2034' })).toBe(true);
      expect(isSerializationFailure({ code: 'P2010', meta: { code: '40001' } })).toBe(true);
      expect(isSerializationFailure({ meta: { code: '40P01' } })).toBe(true);
      expect(isSerializationFailure(new Error('deadlock detected'))).toBe(true);
    });

    it('does not swallow anything else', () => {
      expect(isSerializationFailure({ code: 'P2002' })).toBe(false);
      expect(isSerializationFailure(new AppError('conflict', 'not a serialisation failure'))).toBe(
        false,
      );
      expect(isSerializationFailure(null)).toBe(false);
      expect(isSerializationFailure('40001')).toBe(false);
    });
  });
});
