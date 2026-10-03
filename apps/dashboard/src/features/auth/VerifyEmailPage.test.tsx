import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ApiRequestError } from '../../lib/api';
import { VerifyEmailView, type VerifyEmailOutcome } from './VerifyEmailPage';

/**
 * The failed state carries the resend form, which needs a query client, and
 * the verified state carries a router link. Static markup is enough: every
 * state is a function of `outcome`, and no effect has to run to see it.
 */
function render(outcome: VerifyEmailOutcome): string {
  const wrap = (node: ReactElement) => (
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>
  );
  return renderToStaticMarkup(wrap(<VerifyEmailView outcome={outcome} />));
}

const noop = () => {};

describe('VerifyEmailView', () => {
  it('treats a link with no token the way the reset page does, and still offers a resend', () => {
    const html = render({ kind: 'missing-token' });
    expect(html).toContain('This link is not valid');
    expect(html).toContain('missing its token');
    // A way out that does not require the user to guess a URL.
    expect(html).toContain('data-testid="resend-verification"');
    expect(html).toContain('href="/login"');
  });

  it('announces that it is verifying, not silently spinning', () => {
    const html = render({ kind: 'verifying' });
    expect(html).toContain('Verifying your email');
    expect(html).toContain('role="status"');
    // The spinner is decorative; the text is the status.
    expect(html).toContain('aria-hidden="true"');
  });

  it('routes a verified user to sign in — the response set no session cookie', () => {
    const html = render({ kind: 'verified', email: 'ada@example.com' });
    expect(html).toContain('Email verified');
    expect(html).toContain('ada@example.com');
    expect(html).toContain('data-testid="verified-sign-in"');
    expect(html).toContain('href="/login"');
    // Nothing on this card pretends they are inside the app already.
    expect(html).not.toContain('/orgs');
  });

  it('names an expired or used link from the error CODE and offers a resend inline', () => {
    const html = render({
      kind: 'failed',
      error: new ApiRequestError(400, {
        code: 'invalid_request',
        message: 'This verification link is invalid or has expired.',
        request_id: 'req_verify_1',
      }),
      retry: noop,
    });
    expect(html).toContain('This link has expired or was already used');
    expect(html).toContain('role="alert"');
    expect(html).toContain('req_verify_1');
    // Editable resend: the link carried a token, not an address.
    expect(html).toContain('data-testid="resend-verification"');
    expect(html).toContain('<label');
    expect(html).toContain('Email');
    expect(html).toContain('type="email"');
    // A consumed token cannot be retried; the button must not be offered.
    expect(html).not.toContain('Try this link again');
  });

  it('distinguishes the throttle from a dead link', () => {
    const html = render({
      kind: 'failed',
      error: new ApiRequestError(429, {
        code: 'rate_limited',
        message: 'Too many attempts. Try again shortly.',
        details: { retry_after_seconds: 42 },
      }),
      retry: noop,
    });
    expect(html).toContain('Too many attempts');
    expect(html).not.toContain('This link has expired');
    // Transient: the same token may well work in a minute.
    expect(html).toContain('Try this link again');
  });

  it('offers a retry when the API itself failed, because the token is still unused', () => {
    const html = render({
      kind: 'failed',
      error: new ApiRequestError(503, { code: 'internal_error', message: 'Service Unavailable' }),
      retry: noop,
    });
    expect(html).toContain('We could not verify your email');
    expect(html).toContain('Try this link again');
    expect(html).toContain('data-testid="resend-verification"');
  });

  it('makes the headline focusable so a state change is announced', () => {
    for (const outcome of [
      { kind: 'verifying' },
      { kind: 'verified', email: 'ada@example.com' },
      { kind: 'failed', error: new Error('x'), retry: noop },
    ] satisfies VerifyEmailOutcome[]) {
      expect(render(outcome)).toContain('<h1 tabindex="-1"');
    }
  });
});
