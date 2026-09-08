import { describe, expect, it } from 'vitest';
import { ApiRequestError } from './api';
import { classifyWriteError, writeFailureRemedy, writeFailureTitle } from './api-errors';

const error = (
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
) => new ApiRequestError(status, { code, message, details });

/**
 * A 429 and a resource ceiling are both "your write was refused", and they are
 * the two failures a user is most likely to confuse. Their remedies are
 * opposites: one clears itself, the other never does. If this suite goes green
 * while the UI shows one message for both, a user sits refreshing a form that
 * cannot succeed — or deletes a project they needed because a transient
 * throttle read like a quota.
 */
describe('throttle versus ceiling', () => {
  it('classifies a 429 as transient and carries the retry hint', () => {
    const failure = classifyWriteError(
      error(429, 'rate_limited', 'Too many attempts. Try again shortly.', {
        retry_after_seconds: 42,
      }),
    );

    expect(failure).toMatchObject({ kind: 'throttled', retryAfterSeconds: 42 });
    expect(writeFailureRemedy(failure)).toContain('42 seconds');
    expect(writeFailureRemedy(failure)).toContain('try again');
  });

  it('still classifies a 429 that carries no details', () => {
    const failure = classifyWriteError(error(429, 'rate_limited', 'Too many attempts.'));
    expect(failure).toMatchObject({ kind: 'throttled', retryAfterSeconds: null });
    expect(writeFailureRemedy(failure)).toContain('try again');
  });

  it('classifies a ceiling from its CODE, and never tells the user to wait', () => {
    // Every ceiling raises `limit_exceeded` with { limit, current, resource }.
    const failure = classifyWriteError(
      error(
        409,
        'limit_exceeded',
        'This organization already has 100 projects, which is its limit of 100.',
        { limit: 100, current: 100, resource: 'projects' },
      ),
    );

    expect(failure).toMatchObject({
      kind: 'ceiling',
      limit: 100,
      current: 100,
      resource: 'projects',
    });
    const remedy = writeFailureRemedy(failure);
    expect(remedy).toContain('100 of 100');
    // The resource names what to delete, rather than "delete something".
    expect(remedy).toContain('projects');
    expect(remedy).toContain('does not reset');
    expect(remedy).not.toContain('try again');
  });

  it('classifies a ceiling that arrives with no details at all', () => {
    const failure = classifyWriteError(
      error(409, 'limit_exceeded', 'This project already has 500 endpoints.'),
    );

    expect(failure).toMatchObject({ kind: 'ceiling', limit: null, current: null, resource: null });
    expect(writeFailureRemedy(failure)).toContain('does not reset');
  });

  it('does NOT mistake an ordinary 409 for a ceiling', () => {
    // A duplicate slug is a 409 too. Telling the user to delete a project
    // because they picked a taken name would be actively harmful.
    const failure = classifyWriteError(
      error(409, 'conflict', 'That organization slug is already taken.'),
    );

    expect(failure.kind).toBe('conflict');
  });

  /**
   * The regression the `limit_exceeded` code exists to prevent.
   *
   * This classifier used to fall back to matching the ceiling WORDING, because
   * two of the four ceilings attached no details. A `conflict` phrased like a
   * ceiling was therefore read as one — and the user was told to go and delete
   * something to fix a name collision. The code is now the only signal.
   */
  it('reads a conflict WORDED like a ceiling as an ordinary conflict', () => {
    const failure = classifyWriteError(
      error(409, 'conflict', 'That name is already taken, which is the limit of one per slug.'),
    );

    expect(failure.kind).toBe('conflict');
    expect(writeFailureRemedy(failure)).not.toContain('does not reset');
  });

  it('gives the two failures different headlines', () => {
    const throttled = classifyWriteError(error(429, 'rate_limited', 'Too many attempts.'));
    const ceiling = classifyWriteError(
      error(409, 'limit_exceeded', 'You already own 10 organizations, which is the limit.'),
    );

    expect(writeFailureTitle(throttled)).not.toBe(writeFailureTitle(ceiling));
    expect(writeFailureTitle(throttled)).toMatch(/slow down/i);
    expect(writeFailureTitle(ceiling)).toMatch(/limit/i);
  });

  it('passes other codes through without inventing a category', () => {
    expect(classifyWriteError(error(403, 'forbidden', 'nope')).kind).toBe('forbidden');
    expect(classifyWriteError(error(400, 'invalid_request', 'bad')).kind).toBe('invalid');
    expect(classifyWriteError(new Error('offline')).kind).toBe('other');
  });
});

/**
 * A 400 from the global `ValidationPipe` carries an ARRAY at `error.message`,
 * one entry per rejected property. That array is the ONLY place the API says
 * which field it refused; flattened into a sentence, a form can do nothing but
 * show a paragraph next to the submit button. These are the two rejections an
 * endpoint edit actually meets.
 */
describe('validation issues', () => {
  const validation = (messages: string[]) =>
    new ApiRequestError(400, { code: 'invalid_request', message: messages });

  it('splits each entry into the property that was refused and why', () => {
    const failure = classifyWriteError(
      validation([
        'url: loopback address',
        'name: must be between 1 and 200 characters',
      ]),
    );

    expect(failure.kind).toBe('invalid');
    if (failure.kind !== 'invalid') return;
    expect(failure.issues).toEqual([
      { field: 'url', reason: 'loopback address', message: 'url: loopback address' },
      {
        field: 'name',
        reason: 'must be between 1 and 200 characters',
        message: 'name: must be between 1 and 200 characters',
      },
    ]);
  });

  it('keeps the whole reserved-header sentence, colons and all', () => {
    const message =
      'custom_headers: "Authorization": this header is reserved by the platform and cannot be overridden.';
    const failure = classifyWriteError(validation([message]));

    if (failure.kind !== 'invalid') throw new Error('expected a validation failure');
    expect(failure.issues).toHaveLength(1);
    expect(failure.issues[0].field).toBe('custom_headers');
    // Only the FIRST colon separates the property; the rest is the reason.
    expect(failure.issues[0].reason).toContain('"Authorization"');
    expect(failure.issues[0].reason).toContain('reserved');
  });

  it('leaves a message with no property prefix unattributed rather than guessing', () => {
    const failure = classifyWriteError(
      validation(['https://example.com is not reachable from here']),
    );

    if (failure.kind !== 'invalid') throw new Error('expected a validation failure');
    // A URL contains a colon. Inventing a field called `https` and hanging the
    // error off an input the user cannot see would be worse than not placing it.
    expect(failure.issues[0].field).toBeNull();
  });
});
