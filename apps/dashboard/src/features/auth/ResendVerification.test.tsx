import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ResendAcknowledgement, ResendVerificationForm } from './ResendVerification';

const render = (node: ReactElement) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>,
  );

describe('ResendAcknowledgement', () => {
  /**
   * The route answers an identical 202 for every address so that it cannot be
   * used to enumerate accounts. The copy has to hold that line too: any phrase
   * that reads as confirmation turns the indistinguishable response back into
   * an oracle on the client.
   */
  it('is worded conditionally and never confirms that the address exists', () => {
    const html = renderToStaticMarkup(<ResendAcknowledgement />).toLowerCase();
    expect(html).toContain('if that address has an account');
    for (const leak of [
      'we found',
      'your account',
      'has been sent',
      'was sent',
      'is registered',
      'not registered',
      'no account',
      'already verified',
    ]) {
      expect(html, `acknowledgement must not say "${leak}"`).not.toContain(leak);
    }
  });

  it('is a status region the form can move focus to', () => {
    const html = renderToStaticMarkup(<ResendAcknowledgement />);
    expect(html).toContain('role="status"');
    expect(html).toContain('tabindex="-1"');
  });

  it('tells the user only the newest link works, because earlier ones are revoked', () => {
    expect(renderToStaticMarkup(<ResendAcknowledgement />)).toContain('Only the newest link works');
  });
});

describe('ResendVerificationForm', () => {
  it('locked: one button naming the address, no field to retype', () => {
    const html = render(<ResendVerificationForm email="ada@example.com" locked />);
    expect(html).toContain('Send a new link to ada@example.com');
    expect(html).toContain('<button');
    expect(html).not.toContain('<input');
  });

  it('editable: a labelled email field and a submit', () => {
    const html = render(<ResendVerificationForm />);
    expect(html).toContain('<form');
    expect(html).toContain('<label');
    expect(html).toContain('type="email"');
    // react-dom/server keeps the attribute's case; the browser does not care.
    expect(html.toLowerCase()).toContain('autocomplete="email"');
    expect(html).toContain('Send a new link');
    // (A known address is prefilled through react-hook-form's `defaultValues`,
    // which is applied via the input ref after mount and so is not visible in
    // static markup — the locked mode covers the "address already known" case.)
  });
});
