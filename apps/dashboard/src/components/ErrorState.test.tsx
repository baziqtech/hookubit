import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApiRequestError, ApiTransportError } from '../lib/api';
import { ErrorState } from './ErrorState';

/**
 * The failure surface for a transport failure.
 *
 * A timeout and an unreachable host both carry `internal_error`, because that
 * is the only code the closed `ApiErrorCode` union has for "the API never
 * answered". The copy that code normally gets is wrong for both, so `ErrorState`
 * branches on the transport kind instead — this is the test that the branch is
 * in front of the generic one and that neither failure renders the "quote the
 * request ID" remedy for an ID that cannot exist.
 */
describe('ErrorState — transport failures', () => {
  it('headlines a timeout as the API being slow, not as our bug', () => {
    const html = renderToStaticMarkup(
      <ErrorState error={new ApiTransportError('timeout', 408, 'The control API did not answer.')} />,
    );

    expect(html).toContain('The API did not answer in time');
    expect(html).toContain('The control API did not answer.');
    // The `internal_error` copy, which is wrong here twice over.
    expect(html).not.toContain('Something went wrong on our side');
    expect(html).not.toContain('Quote the request ID');
    expect(html).not.toContain('An unexpected error occurred');
    // The chip is the useful token, not the catch-all code.
    expect(html).toContain('timeout');
  });

  it('headlines an unreachable host as reachability, which is the operator’s own setting', () => {
    const html = renderToStaticMarkup(
      <ErrorState error={new ApiTransportError('unreachable', 503, 'CORS_ORIGINS, maybe.')} />,
    );

    expect(html).toContain('Could not reach the API');
    expect(html).toContain('CORS_ORIGINS, maybe.');
    expect(html).not.toContain('Something went wrong on our side');
    expect(html).toContain('unreachable');
  });

  it('still renders the code-keyed remedy for an error the API did send', () => {
    const html = renderToStaticMarkup(
      <ErrorState
        error={
          new ApiRequestError(500, {
            code: 'internal_error',
            message: 'Boom.',
            request_id: 'req_7',
          })
        }
      />,
    );

    expect(html).toContain('Something went wrong on our side');
    expect(html).toContain('Quote the request ID');
    expect(html).toContain('req_7');
  });
});
