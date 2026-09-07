import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApiRequestError } from '../lib/api';
import { WriteErrorNotice } from './WriteErrorNotice';

const render = (error: unknown) => renderToStaticMarkup(<WriteErrorNotice error={error} />);

/**
 * No jsdom or Testing Library in this workspace, so these assert on markup —
 * which is enough for the property that matters: a throttle and a ceiling must
 * not render the same thing.
 */
describe('WriteErrorNotice', () => {
  it('tells a 429 to wait, and says how long', () => {
    const html = render(
      new ApiRequestError(429, {
        code: 'rate_limited',
        message: 'Too many attempts. Try again shortly.',
        details: { retry_after_seconds: 42 },
      }),
    );

    expect(html).toContain('data-failure-kind="throttled"');
    expect(html).toContain('slow down');
    expect(html).toContain('42 seconds');
  });

  it('tells a ceiling that waiting will NOT help', () => {
    const html = render(
      new ApiRequestError(409, {
        code: 'conflict',
        message: 'This project already holds 50 un-revoked API keys, which is its limit of 50.',
        details: { limit: 50, current: 50 },
      }),
    );

    expect(html).toContain('data-failure-kind="ceiling"');
    expect(html).toContain('reached a limit');
    expect(html).toContain('50 of 50');
    // The distinction the user acts on: a ceiling never resolves by itself.
    expect(html).toContain('does not reset');
    expect(html).not.toContain('try again');
  });

  it('renders the two failures differently', () => {
    const throttled = render(
      new ApiRequestError(429, { code: 'rate_limited', message: 'Too many attempts.' }),
    );
    const ceiling = render(
      new ApiRequestError(409, {
        code: 'conflict',
        message: 'You already own 10 organizations, which is the limit.',
      }),
    );

    expect(throttled).not.toBe(ceiling);
    expect(throttled).toContain('data-failure-kind="throttled"');
    expect(ceiling).toContain('data-failure-kind="ceiling"');
  });

  it('does not misread an ordinary conflict as a ceiling', () => {
    const html = render(
      new ApiRequestError(409, {
        code: 'conflict',
        message: 'That organization slug is already taken.',
      }),
    );

    expect(html).toContain('data-failure-kind="conflict"');
    expect(html).not.toContain('does not reset');
  });
});
