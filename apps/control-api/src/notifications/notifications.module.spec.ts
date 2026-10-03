import { INestApplication, Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { AuthModule } from '../auth/auth.module';
import { DevelopmentAuthMailer, MAILER_PORT } from '../auth/mailer.port';
import { AuthzModule } from '../authz/authz.module';
import { CommonModule } from '../common/common.module';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { DevelopmentInvitationMailer, INVITATION_MAILER } from '../members/invitation-mailer.port';
import { MembersModule } from '../members/members.module';
import { MAIL_TRANSPORT } from './mail-transport';
import { SmtpMailer } from './smtp-mailer';
import { NodemailerSmtpTransport } from './smtp-transport';

/**
 * The DI graph, compiled and BOOTED, for both modules that bind a mailer port.
 *
 * The selection rule is a factory provider wired into two modules that this
 * module does not own, so a unit test of `selectMailer` proves nothing about
 * whether `AuthModule` can actually resolve `MAIL_TRANSPORT` - that needs the
 * import list to be right, and `PrismaModule` is deliberately not `@Global()`
 * (see maintenance.module.spec.ts for the module that shipped that bug).
 *
 * `ConfigModule` reads `process.env` ahead of anything passed through `load`,
 * so the variables are set on the process and restored afterwards, the way
 * tracing.module.spec.ts does it.
 *
 * The SMTP case points at 127.0.0.1:1, which refuses immediately. Booting
 * through `app.init()` runs `onApplicationBootstrap`, which is the one place
 * the transport talks to the network at boot - and the assertion is that a
 * refused connection is a WARNING line, not a failed boot.
 */
describe('NotificationsModule wiring (real DI graph)', () => {
  const KEYS = ['APP_ENV', 'SMTP_URL', 'MAIL_FROM', 'DASHBOARD_URL', 'JWT_SECRET', 'DATABASE_URL'] as const;
  const saved: Record<string, string | undefined> = {};
  let warned: string[];

  const setEnv = (values: Partial<Record<(typeof KEYS)[number], string>>): void => {
    for (const key of KEYS) {
      const value = values[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };

  const base = {
    JWT_SECRET: 'x'.repeat(32),
    // Only has to satisfy PrismaClient's constructor; the service is overridden below.
    DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused',
    DASHBOARD_URL: 'http://localhost:5173',
  };

  beforeAll(() => {
    for (const key of KEYS) saved[key] = process.env[key];
  });

  beforeEach(() => {
    warned = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation((m: unknown) => {
      warned.push(String(m));
    });
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  // The graph is resolved for real; only the database is stubbed, because
  // `app.init()` would otherwise run `PrismaService.onModuleInit` and connect.
  // An inert object has no lifecycle hooks and satisfies every injection site.
  const compile = (...modules: unknown[]): Promise<TestingModule> =>
    Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), CommonModule, ...(modules as never[])],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();

  it('binds BOTH ports to SmtpMailer over ONE transport when SMTP_URL is set, and boots with the server down', async () => {
    setEnv({
      ...base,
      APP_ENV: 'development',
      SMTP_URL: 'smtp://127.0.0.1:1',
      MAIL_FROM: 'HookuBit <no-reply@localhost>',
    });

    const moduleRef = await compile(AuthzModule, MembersModule);
    let app: INestApplication | undefined;
    try {
      app = moduleRef.createNestApplication();
      await app.init();

      expect(app.get(MAILER_PORT)).toBeInstanceOf(SmtpMailer);
      expect(app.get(INVITATION_MAILER)).toBeInstanceOf(SmtpMailer);
      expect(app.get(MAIL_TRANSPORT)).toBeInstanceOf(NodemailerSmtpTransport);

      // One transport, shared: the factory provider lives in NotificationsModule,
      // and Nest module instances are singletons.
      expect(app.select(AuthModule).get(MAIL_TRANSPORT)).toBe(
        app.select(MembersModule).get(MAIL_TRANSPORT),
      );

      // The lifecycle hook fired on the factory-provided instance and the
      // refused connection was reported, not thrown.
      expect(warned.some((line) => line.includes('could not be verified at boot'))).toBe(true);
    } finally {
      await app?.close();
    }
  });

  it('binds the development stubs when SMTP_URL is unset in a stub-safe environment', async () => {
    setEnv({ ...base, APP_ENV: 'test' });

    const moduleRef = await compile(AuthzModule, MembersModule);
    try {
      expect(moduleRef.get(MAILER_PORT)).toBeInstanceOf(DevelopmentAuthMailer);
      expect(moduleRef.get(INVITATION_MAILER)).toBeInstanceOf(DevelopmentInvitationMailer);
      expect(moduleRef.get(MAIL_TRANSPORT)).toBeNull();
    } finally {
      await moduleRef.close();
    }
  });

  it('REFUSES to build the graph under APP_ENV=production with no SMTP_URL, naming the variable', async () => {
    setEnv({ ...base, APP_ENV: 'production' });
    await expect(compile(AuthModule)).rejects.toThrow(/SMTP_URL is not set and APP_ENV=production/);
  });

  it('uses SMTP under APP_ENV=production when SMTP_URL is set - the same code path as development', async () => {
    setEnv({
      ...base,
      APP_ENV: 'production',
      SMTP_URL: 'smtps://mailer:secret@mail.example.com:465',
      MAIL_FROM: 'HookuBit <no-reply@example.com>',
    });

    const moduleRef = await compile(AuthModule);
    try {
      expect(moduleRef.get(MAILER_PORT)).toBeInstanceOf(SmtpMailer);
    } finally {
      await moduleRef.close();
    }
  });
});
