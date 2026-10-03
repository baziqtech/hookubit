import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApiRequestError } from '../../lib/api';
import { LoginError } from './LoginPage';

const GENERIC_MESSAGE = 'Email or password is incorrect.';

describe('LoginError', () => {
  it('tells an unverified user to look for the verification email', () => {
    const html = renderToStaticMarkup(
      <LoginError
        error={
          new ApiRequestError(403, {
            code: 'email_not_verified',
            // The server message is deliberately NOT what the user reads.
            message: 'Email address is not verified.',
            request_id: 'req_123',
          })
        }
      />,
    );

    expect(html).toContain('Check your email to verify this address');
    expect(html).toContain('verification link');
    expect(html).not.toContain(GENERIC_MESSAGE);
    expect(html).toContain('req_123');
  });

  it('falls back to the generic form error for every other code', () => {
    const html = renderToStaticMarkup(
      <LoginError
        error={new ApiRequestError(401, { code: 'unauthenticated', message: GENERIC_MESSAGE })}
      />,
    );

    expect(html).toContain(GENERIC_MESSAGE);
    expect(html).not.toContain('Check your email to verify this address');
  });

  it('renders nothing before a submission fails', () => {
    expect(renderToStaticMarkup(<LoginError error={null} />)).toBe('');
  });

  it('renders the resend action inside the unverified panel, and nowhere else', () => {
    const unverified = new ApiRequestError(403, {
      code: 'email_not_verified',
      message: 'Email address is not verified.',
    });
    const action = <button data-testid="resend-action">Resend</button>;

    const html = renderToStaticMarkup(<LoginError error={unverified} action={action} />);
    expect(html).toContain('data-testid="login-email-not-verified"');
    expect(html).toContain('data-testid="resend-action"');

    // A wrong password gets no resend: the account may not even exist, and
    // offering to mail it would say otherwise.
    const generic = renderToStaticMarkup(
      <LoginError
        error={new ApiRequestError(401, { code: 'unauthenticated', message: GENERIC_MESSAGE })}
        action={action}
      />,
    );
    expect(generic).not.toContain('data-testid="resend-action"');
  });
});
