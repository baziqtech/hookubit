import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { RegistrationAccepted } from './RegisterPage';

const render = (email: string) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <RegistrationAccepted email={email} />
      </MemoryRouter>
    </QueryClientProvider>,
  );

describe('RegistrationAccepted', () => {
  it('keeps the unconditional wording and adds a resend for the typed address', () => {
    const html = render('ada@example.com');
    expect(html).toContain('Check your email');
    // Conditional on its face: the 202 is the same for a taken address.
    expect(html).toContain('If we can create an account for that address');
    expect(html).toContain('Send a new link to ada@example.com');
    expect(html).toContain('href="/login"');
  });

  it('does not distinguish a taken address from a free one', () => {
    const html = render('taken@example.com').toLowerCase();
    expect(html).not.toContain('already');
    expect(html).not.toContain('exists');
  });
});
