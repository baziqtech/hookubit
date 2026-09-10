import { Logger } from '@nestjs/common';
import { createTransport } from 'nodemailer';
import { MailDeliveryError, OutboundMail } from './mail-transport';
import { NodemailerSmtpTransport, SMTP_TIMEOUTS_MS } from './smtp-transport';

jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));

const SMTP_URL = 'smtp://mailer:hunter2@mail.example.com:587';
const FROM = 'Hookubit <no-reply@example.com>';

const mail: OutboundMail = {
  kind: 'email_verification',
  to: 'ada@example.com',
  subject: 'Confirm your email address',
  text: 'link: https://app.example.com/verify-email?token=SECRET',
  html: '<a href="https://app.example.com/verify-email?token=SECRET">Confirm</a>',
};

interface FakeTransporter {
  sendMail: jest.Mock;
  verify: jest.Mock;
  close: jest.Mock;
}

describe('NodemailerSmtpTransport', () => {
  let fake: FakeTransporter;
  let logged: string[];
  let warned: string[];

  beforeEach(() => {
    fake = {
      sendMail: jest.fn().mockResolvedValue({ messageId: '<abc@example.com>' }),
      verify: jest.fn().mockResolvedValue(true),
      close: jest.fn(),
    };
    (createTransport as jest.Mock).mockReset().mockReturnValue(fake);
    logged = [];
    warned = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((m: unknown) => {
      logged.push(String(m));
    });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation((m: unknown) => {
      warned.push(String(m));
    });
  });

  afterEach(() => jest.restoreAllMocks());

  it('hands nodemailer the URL untouched plus request-path-safe timeouts', () => {
    new NodemailerSmtpTransport(SMTP_URL, FROM);
    expect(createTransport).toHaveBeenCalledWith({
      url: SMTP_URL,
      connectionTimeout: SMTP_TIMEOUTS_MS.connection,
      greetingTimeout: SMTP_TIMEOUTS_MS.greeting,
      socketTimeout: SMTP_TIMEOUTS_MS.socket,
    });
    // A dead host must not turn registration into a two-minute request.
    expect(SMTP_TIMEOUTS_MS.connection).toBeLessThanOrEqual(10_000);
  });

  it('sends from MAIL_FROM with both parts and marks the message auto-generated', async () => {
    const transport = new NodemailerSmtpTransport(SMTP_URL, FROM);
    const receipt = await transport.send(mail);

    expect(receipt).toEqual({ messageId: '<abc@example.com>' });
    expect(fake.sendMail).toHaveBeenCalledTimes(1);
    expect(fake.sendMail.mock.calls[0][0]).toEqual({
      from: FROM,
      to: { name: '', address: 'ada@example.com' },
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      headers: { 'Auto-Submitted': 'auto-generated' },
    });
  });

  it('never logs the message body - it contains the link', async () => {
    const transport = new NodemailerSmtpTransport(SMTP_URL, FROM);
    await transport.send(mail);
    await transport.onApplicationBootstrap();
    for (const line of [...logged, ...warned]) {
      expect(line).not.toContain('SECRET');
      expect(line).not.toContain('token=');
    }
  });

  it('wraps a rejection into MailDeliveryError with every address scrubbed and the code kept', async () => {
    const rejection = Object.assign(
      new Error('Can\'t send mail - all recipients were rejected: 550 5.1.1 <ada@example.com>: Recipient address rejected'),
      { code: 'EENVELOPE' },
    );
    fake.sendMail.mockRejectedValue(rejection);
    const transport = new NodemailerSmtpTransport(SMTP_URL, FROM);

    let caught: unknown;
    try {
      await transport.send(mail);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(MailDeliveryError);
    const error = caught as MailDeliveryError;
    expect(error.kind).toBe('email_verification');
    expect(error.code).toBe('EENVELOPE');
    expect(error.message).not.toContain('ada@example.com');
    expect(error.message).toContain('550 5.1.1');
    // Callers log `err.message`; nothing else on the error may carry the address.
    expect(JSON.stringify(error)).not.toContain('ada@example.com');
    expect('cause' in error && error.cause).toBeFalsy();
  });

  it('names the host in errors but never the credentials in SMTP_URL', async () => {
    fake.sendMail.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const transport = new NodemailerSmtpTransport(SMTP_URL, FROM);
    await expect(transport.send(mail)).rejects.toThrow(/smtp:\/\/mail\.example\.com:587/);
    await expect(transport.send(mail)).rejects.not.toThrow(/hunter2/);
  });

  it('verifies at boot and WARNS rather than refusing when the server is unreachable', async () => {
    fake.verify.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.9:587'));
    const transport = new NodemailerSmtpTransport(SMTP_URL, FROM);

    await expect(transport.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('could not be verified at boot');
    expect(warned[0]).toContain('ECONNREFUSED');
    expect(warned[0]).not.toContain('hunter2');
  });

  it('logs readiness when verification succeeds and closes the pool on shutdown', async () => {
    const transport = new NodemailerSmtpTransport(SMTP_URL, FROM);
    await transport.onApplicationBootstrap();
    expect(logged).toEqual(['SMTP transport ready at smtp://mail.example.com:587.']);
    transport.onApplicationShutdown();
    expect(fake.close).toHaveBeenCalledTimes(1);
  });
});
