import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { DevelopmentAuthMailer } from './mailer.port';

const RAW_TOKEN = 'Zm9yZ2VkLXRva2VuLXRoYXQtdW5sb2Nrcy10aGUtYWNjb3VudA';
const EMAIL = 'ada@example.com';

function configFor(appEnv: string): ConfigService {
  return { get: (key: string) => (key === 'APP_ENV' ? appEnv : undefined) } as ConfigService;
}

describe('DevelopmentAuthMailer (FIX 5)', () => {
  let logged: string[];
  let stdout: jest.SpyInstance;

  beforeEach(() => {
    logged = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => {
      logged.push(String(message));
    });
    stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => jest.restoreAllMocks());

  it('REGRESSION: never emits the raw token, and never bypasses the logger', async () => {
    const mailer = new DevelopmentAuthMailer(configFor('development'));

    await mailer.sendEmailVerification(EMAIL, RAW_TOKEN);
    await mailer.sendPasswordReset(EMAIL, RAW_TOKEN);

    // `process.stdout.write` bypasses pino, so app.module.ts's redaction config
    // could not touch it: one wrong APP_ENV shipped full account-takeover
    // tokens into centralised logging, next to the address they unlock.
    expect(stdout).not.toHaveBeenCalled();
    expect(logged).toHaveLength(2);
    for (const line of logged) {
      expect(line).not.toContain(RAW_TOKEN);
      // A prefix is enough to correlate two log lines and useless to a reader.
      expect(line).toContain(RAW_TOKEN.slice(0, 6));
      expect(line).not.toContain(RAW_TOKEN.slice(0, 12));
    }
  });

  it('logs a registration-attempt notice, which carries no token at all', async () => {
    const mailer = new DevelopmentAuthMailer(configFor('development'));
    await mailer.sendRegistrationAttemptNotice(EMAIL);

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(EMAIL);
  });

  it('boots under development and test, where there is no inbox and no real user', () => {
    expect(() => new DevelopmentAuthMailer(configFor('development'))).not.toThrow();
    expect(() => new DevelopmentAuthMailer(configFor('test'))).not.toThrow();
  });

  it('REGRESSION: refuses to boot in staging or production', () => {
    // It delivers nothing, so binding it outside development left registration
    // and password reset silently non-functional while the app reported healthy.
    expect(() => new DevelopmentAuthMailer(configFor('staging'))).toThrow(/APP_ENV=staging/);
    expect(() => new DevelopmentAuthMailer(configFor('production'))).toThrow(/real.*transport/i);
  });
});
