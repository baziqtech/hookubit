import { TOKEN_TTL_MS } from '../auth/token.service';
import {
  alreadyMemberMail,
  buildDashboardLink,
  describeDuration,
  emailVerificationMail,
  invitationMail,
  passwordResetMail,
  registrationAttemptMail,
} from './templates';

const ctx = { productName: 'HookuBit', dashboardUrl: 'https://app.example.com' };
const TOKEN = 'Zm9yZ2VkLXRva2VuLXRoYXQtdW5sb2Nrcy10aGUtYWNjb3VudA';

describe('buildDashboardLink', () => {
  it('builds the shape the dashboard reads: <base>/<page>?token=<raw>', () => {
    expect(buildDashboardLink('http://localhost:5173', '/verify-email', { token: TOKEN })).toBe(
      `http://localhost:5173/verify-email?token=${TOKEN}`,
    );
  });

  it('keeps a base path and never doubles the slash', () => {
    expect(buildDashboardLink('https://example.com/dash/', '/reset-password', { token: 't' })).toBe(
      'https://example.com/dash/reset-password?token=t',
    );
    expect(buildDashboardLink('https://example.com', 'reset-password')).toBe(
      'https://example.com/reset-password',
    );
  });

  it('percent-encodes the token rather than concatenating it', () => {
    const link = buildDashboardLink('https://example.com', '/verify-email', { token: 'a+b/c=&d' });
    expect(link).toBe('https://example.com/verify-email?token=a%2Bb%2Fc%3D%26d');
    expect(new URL(link).searchParams.get('token')).toBe('a+b/c=&d');
  });

  it('drops any query or fragment the base carried', () => {
    expect(buildDashboardLink('https://example.com/?utm=x#frag', '/verify-email', { token: 't' })).toBe(
      'https://example.com/verify-email?token=t',
    );
  });
});

describe('templates', () => {
  it('email verification carries the link in both parts and states the real lifetime', () => {
    const link = `https://app.example.com/verify-email?token=${TOKEN}`;
    const mail = emailVerificationMail(ctx, link);
    expect(mail.subject).toBe('Confirm your email address for HookuBit');
    expect(mail.text).toContain(link);
    expect(mail.html).toContain(`href="${link}"`);
    expect(mail.text).toContain(describeDuration(TOKEN_TTL_MS.email_verification));
  });

  it('password reset states the backend lifetime, not a number typed into the template', () => {
    const mail = passwordResetMail(ctx, 'https://app.example.com/reset-password?token=t');
    expect(mail.text).toContain(`expires in ${describeDuration(TOKEN_TTL_MS.password_reset)}`);
    expect(mail.subject).toBe('Reset your HookuBit password');
  });

  it('the registration-attempt notice carries no token and points at login and forgot-password', () => {
    const mail = registrationAttemptMail(ctx);
    expect(mail.text).not.toContain('token');
    expect(mail.html).not.toContain('token');
    expect(mail.text).toContain('https://app.example.com/login');
    expect(mail.text).toContain('https://app.example.com/forgot-password');
  });

  it('invitation names the inviter, the organization, the role and the address to accept with', () => {
    const link = `https://app.example.com/accept-invitation?token=${TOKEN}`;
    const mail = invitationMail(ctx, {
      organizationName: 'Acme Corp',
      invitedByEmail: 'owner@acme.example',
      role: 'developer',
      email: 'new@acme.example',
      link,
    });
    expect(mail.subject).toBe('owner@acme.example invited you to Acme Corp on HookuBit');
    expect(mail.text).toContain('as developer');
    expect(mail.text).toContain('signed in as new@acme.example');
    expect(mail.text).toContain(link);
    expect(mail.html).toContain(`href="${link}"`);
    expect(mail.text).toContain(describeDuration(TOKEN_TTL_MS.invitation));
  });

  it('HTML-escapes tenant-controlled text and collapses it to one line in the subject', () => {
    const mail = invitationMail(ctx, {
      organizationName: '<script>alert(1)</script>\nEvil & Co',
      invitedByEmail: 'x@example.com',
      role: 'viewer',
      email: 'y@example.com',
      link: 'https://app.example.com/accept-invitation?token=t',
    });
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; Evil &amp; Co');
    expect(mail.subject).not.toContain('\n');
    expect(mail.subject).toContain('<script>alert(1)</script> Evil & Co');
  });

  it('the already-a-member notice carries no token', () => {
    const mail = alreadyMemberMail(ctx, 'Acme Corp');
    expect(mail.subject).toBe('You are already a member of Acme Corp');
    expect(mail.text).not.toContain('token');
    expect(mail.text).toContain('https://app.example.com/');
  });
});

describe('describeDuration', () => {
  it.each([
    [60 * 60 * 1000, '1 hour'],
    [2 * 60 * 60 * 1000, '2 hours'],
    [24 * 60 * 60 * 1000, '1 day'],
    [7 * 24 * 60 * 60 * 1000, '7 days'],
    [30 * 60 * 1000, '30 minutes'],
    [36 * 60 * 60 * 1000, '36 hours'],
  ])('%d ms reads as %s', (ms, expected) => {
    expect(describeDuration(ms)).toBe(expected);
  });
});
