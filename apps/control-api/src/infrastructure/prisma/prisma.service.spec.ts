import { PrismaClient } from '@prisma/client';
import { PrismaService } from './prisma.service';

/**
 * The tracing hook is installed here and nowhere else, so this is the only
 * place that can catch two failures that no other test would:
 *
 *  - Prisma removing `$use` (it is soft-deprecated in favour of client
 *    extensions), which would be a TypeError at boot rather than a compile
 *    error, because the generated client declares it;
 *  - the hook being installed AFTER `$connect`, which would leave the queries
 *    that run during startup untraced and would look identical in review.
 */
describe('PrismaService', () => {
  const savedUrl = process.env.DATABASE_URL;

  beforeAll(() => {
    // Constructing the client reads the datasource; it opens nothing.
    process.env.DATABASE_URL ??= 'postgresql://user:pass@127.0.0.1:5432/unused';
  });

  afterAll(() => {
    if (savedUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedUrl;
  });

  it('still has the $use hook the tracing middleware is installed through', () => {
    expect(typeof PrismaClient.prototype.$use).toBe('function');
  });

  it('installs the tracing middleware BEFORE connecting', async () => {
    const service = new PrismaService();
    const order: string[] = [];

    jest.spyOn(service, '$use').mockImplementation(() => {
      order.push('$use');
    });
    jest.spyOn(service, '$connect').mockImplementation(async () => {
      order.push('$connect');
    });

    await service.onModuleInit();

    expect(order).toEqual(['$use', '$connect']);
    jest.restoreAllMocks();
  });

  it('disconnects on destroy', async () => {
    const service = new PrismaService();
    const disconnect = jest
      .spyOn(service, '$disconnect')
      .mockImplementation(async () => undefined);

    await service.onModuleDestroy();

    expect(disconnect).toHaveBeenCalled();
    jest.restoreAllMocks();
  });
});
