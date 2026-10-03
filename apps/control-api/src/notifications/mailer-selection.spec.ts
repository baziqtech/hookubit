import { ConfigService } from '@nestjs/config';
import { MailTransport } from './mail-transport';
import { createMailTransport, selectMailer, templateContextFrom } from './mailer-selection';
import { NodemailerSmtpTransport } from './smtp-transport';

function configOf(values: Record<string, string | undefined>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

const transport: MailTransport = { send: async () => ({ messageId: null }) };

const choices = {
  smtp: (t: MailTransport, context: { productName: string }) => `smtp:${context.productName}:${t === transport}`,
  stub: () => 'stub',
};

describe('selectMailer', () => {
  it.each(['development', 'test', 'staging', 'production'])(
    'uses SMTP whenever a transport exists, including under APP_ENV=%s',
    (appEnv) => {
      const config = configOf({ APP_ENV: appEnv, MAIL_FROM: 'HookuBit <no-reply@example.com>' });
      expect(selectMailer(config, transport, choices)).toBe('smtp:HookuBit:true');
    },
  );

  it.each(['development', 'test'])('falls back to the stub with no transport under APP_ENV=%s', (appEnv) => {
    expect(selectMailer(configOf({ APP_ENV: appEnv }), null, choices)).toBe('stub');
  });

  it('treats a missing APP_ENV as development, matching the schema default', () => {
    expect(selectMailer(configOf({}), null, choices)).toBe('stub');
  });

  it.each(['staging', 'production'])(
    'REFUSES to build anything with no transport under APP_ENV=%s, naming SMTP_URL',
    (appEnv) => {
      expect(() => selectMailer(configOf({ APP_ENV: appEnv }), null, choices)).toThrow(
        new RegExp(`SMTP_URL is not set and APP_ENV=${appEnv}`),
      );
    },
  );
});

describe('createMailTransport', () => {
  it('is null - not a stub, not a throw - when SMTP_URL is unset or blank', () => {
    expect(createMailTransport(configOf({}))).toBeNull();
    expect(createMailTransport(configOf({ SMTP_URL: '   ' }))).toBeNull();
  });

  it('builds the SMTP transport from SMTP_URL and MAIL_FROM', () => {
    const built = createMailTransport(
      configOf({ SMTP_URL: 'smtp://127.0.0.1:1025', MAIL_FROM: 'HookuBit <no-reply@localhost>' }),
    );
    expect(built).toBeInstanceOf(NodemailerSmtpTransport);
  });

  it.each([undefined, '', 'not a mailbox'])(
    'refuses SMTP_URL with MAIL_FROM %j - a transport with no sender cannot send',
    (from) => {
      expect(() =>
        createMailTransport(configOf({ SMTP_URL: 'smtp://127.0.0.1:1025', MAIL_FROM: from })),
      ).toThrow(/MAIL_FROM must be set/);
    },
  );
});

describe('templateContextFrom', () => {
  it('takes the product name from MAIL_FROM so the From line and the body agree', () => {
    const context = templateContextFrom(
      configOf({ DASHBOARD_URL: 'https://app.example.com', MAIL_FROM: 'ShaQ Hooks <no-reply@example.com>' }),
    );
    expect(context).toEqual({ dashboardUrl: 'https://app.example.com', productName: 'ShaQ Hooks' });
  });

  it('falls back to the dashboard host for a bare From address', () => {
    const context = templateContextFrom(
      configOf({ DASHBOARD_URL: 'https://app.example.com:8443/', MAIL_FROM: 'no-reply@example.com' }),
    );
    expect(context.productName).toBe('app.example.com:8443');
  });

  it('defaults the dashboard URL to the local dev server when unset', () => {
    expect(templateContextFrom(configOf({})).dashboardUrl).toBe('http://localhost:5173');
  });
});
