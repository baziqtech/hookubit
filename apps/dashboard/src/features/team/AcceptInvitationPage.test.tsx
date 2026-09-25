import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ApiRequestError } from '../../lib/api';
import type { Organization } from '../../types/api';
import {
  AcceptInvitationView,
  returnPathFor,
  type AcceptInvitationOutcome,
} from './AcceptInvitationPage';

/**
 * Static markup is enough: every state is a function of `outcome`, and no
 * effect has to run to see it. The router is for the links, the query client
 * because `FormError`'s neighbours expect one in the tree.
 */
function render(outcome: AcceptInvitationOutcome): string {
  const wrap = (node: ReactElement) => (
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>
  );
  return renderToStaticMarkup(wrap(<AcceptInvitationView outcome={outcome} />));
}

const noop = () => {};

const northline: Organization = {
  id: 'org_01JQNORTH',
  name: 'Northline Freight',
  slug: 'northline-freight',
  status: 'active',
  role: 'developer',
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
};

function failed(error: unknown): AcceptInvitationOutcome {
  return {
    kind: 'failed',
    error,
    email: 'najib@shaqexpress.com',
    retry: noop,
    signOut: noop,
    signingOut: false,
  };
}

describe('returnPathFor', () => {
  it('keeps the token: the query string is the part a sign-in detour must not drop', () => {
    expect(returnPathFor({ pathname: '/accept-invitation', search: '?token=inv_abc' })).toBe(
      '/accept-invitation?token=inv_abc',
    );
  });
});

describe('AcceptInvitationView', () => {
  it('treats a link with no token the way the verify and reset pages do', () => {
    const html = render({ kind: 'missing-token' });
    expect(html).toContain('This link is not valid');
    expect(html).toContain('missing its token');
    expect(html).toContain('href="/login"');
    // No spinner, no POST pretended: there is nothing to send.
    expect(html).not.toContain('role="status"');
  });

  it('announces that it is checking the session, not silently spinning', () => {
    const html = render({ kind: 'checking-session' });
    expect(html).toContain('Opening your invitation');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-hidden="true"');
  });

  it('offers a retry when the session check itself failed — the token is untouched', () => {
    const html = render({
      kind: 'session-unavailable',
      error: new ApiRequestError(503, { code: 'internal_error', message: 'Service Unavailable' }),
      retry: noop,
    });
    expect(html).toContain('We could not check your session');
    expect(html).toContain('role="alert"');
    expect(html).toContain('Try again');
  });

  it('sends a signed-out invitee to sign in or register, and says the link survives the detour', () => {
    const html = render({ kind: 'signed-out', returnTo: '/accept-invitation?token=inv_abc' });
    expect(html).toContain('Sign in to accept this invitation');
    expect(html).toContain('data-testid="signed-out-sign-in"');
    expect(html).toContain('href="/login"');
    expect(html).toContain('data-testid="signed-out-register"');
    expect(html).toContain('href="/register"');
    // Registration ends in an email hop that no router state survives, so the
    // instruction is to come back through the link itself.
    expect(html).toContain('open this invitation link again');
    // Nothing on this card pretends they are inside the app already.
    expect(html).not.toContain('/orgs');
  });

  it('asks before redeeming, names the account it would redeem for, and offers sign-out first', () => {
    const html = render({
      kind: 'confirm',
      email: 'najib@shaqexpress.com',
      accept: noop,
      signOut: noop,
      signingOut: false,
    });
    expect(html).toContain('Accept this invitation?');
    // The server consumes the token before it checks the account, so the page
    // must never post on mount: the button IS the redemption.
    expect(html).toContain('data-testid="confirm-accept"');
    expect(html).toContain('Accept as najib@shaqexpress.com');
    expect(html).toContain('uses it up');
    expect(html).toContain('data-testid="confirm-sign-out"');
    expect(html).toContain('Sign out');
  });

  it('names the address the acceptance is being made as while it is in flight', () => {
    const html = render({ kind: 'accepting', email: 'najib@shaqexpress.com' });
    expect(html).toContain('Accepting your invitation');
    expect(html).toContain('najib@shaqexpress.com');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-hidden="true"');
  });

  it('routes an accepted invitee into the organization and announces the role granted', () => {
    const html = render({ kind: 'accepted', organization: northline });
    expect(html).toContain('You are a member of Northline Freight');
    expect(html).toContain('data-testid="accepted-open"');
    expect(html).toContain('href="/orgs/org_01JQNORTH"');
    // The role is a live region, not a colour.
    expect(html).toContain('role="status"');
    expect(html).toContain('data-testid="accepted-role"');
    expect(html).toContain('Developer');
  });

  it('names a dead token from the error CODE and offers both ways forward', () => {
    const html = render(
      failed(
        new ApiRequestError(400, {
          code: 'invalid_request',
          message: 'This invitation is invalid or has expired.',
          request_id: 'req_invite_1',
        }),
      ),
    );
    expect(html).toContain('This invitation cannot be used');
    expect(html).toContain('role="alert"');
    expect(html).toContain('req_invite_1');
    // The server cannot say which, so the page names all three honestly…
    expect(html).toContain('expired');
    expect(html).toContain('already been used');
    expect(html).toContain('different');
    // …including the address the token was checked against.
    expect(html).toContain('najib@shaqexpress.com');
    expect(html).toContain('new invitation');
    expect(html).toContain('Sign out');
    // A consumed token cannot be retried; the button must not be offered.
    expect(html).not.toContain('Try again');
  });

  it('shows the server sentence for a conflict, and says the token is spent', () => {
    const html = render(
      failed(
        new ApiRequestError(409, {
          code: 'conflict',
          message:
            'The member who invited you is no longer part of that organization. Ask for a new invitation.',
          request_id: 'req_invite_2',
        }),
      ),
    );
    expect(html).toContain('This invitation cannot be completed');
    expect(html).toContain('no longer part of that organization');
    expect(html).toContain('used the invitation up');
    expect(html).not.toContain('Try again');
    // The address was fine; switching account is not the way forward.
    expect(html).not.toContain('Sign out');
  });

  it('distinguishes the throttle from a dead token', () => {
    const html = render(
      failed(
        new ApiRequestError(429, {
          code: 'rate_limited',
          message: 'Too many attempts. Try again shortly.',
          details: { retry_after_seconds: 42 },
        }),
      ),
    );
    expect(html).toContain('Too many attempts');
    expect(html).not.toContain('cannot be used');
    expect(html).toContain('Try again');
  });

  it('offers a retry when the API itself failed', () => {
    const html = render(
      failed(new ApiRequestError(503, { code: 'internal_error', message: 'Service Unavailable' })),
    );
    expect(html).toContain('We could not accept this invitation');
    expect(html).toContain('Try again');
  });

  it('makes the headline focusable so a state change is announced', () => {
    for (const outcome of [
      { kind: 'checking-session' },
      { kind: 'session-unavailable', error: new Error('x'), retry: noop },
      { kind: 'signed-out', returnTo: '/accept-invitation?token=inv_abc' },
      { kind: 'accepting', email: 'najib@shaqexpress.com' },
      { kind: 'accepted', organization: northline },
      failed(new Error('x')),
    ] satisfies AcceptInvitationOutcome[]) {
      expect(render(outcome)).toContain('<h1 tabindex="-1"');
    }
  });
});
