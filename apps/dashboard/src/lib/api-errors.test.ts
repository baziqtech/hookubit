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

  it('classifies a ceiling with details exactly, and never tells the user to wait', () => {
    // Projects and API keys attach { limit, current }.
    const failure = classifyWriteError(
      error(
        409,
        'conflict',
        'This organization already has 100 projects, which is its limit of 100.',
        { limit: 100, current: 100 },
      ),
    );

    expect(failure).toMatchObject({ kind: 'ceiling', limit: 100, current: 100 });
    const remedy = writeFailureRemedy(failure);
    expect(remedy).toContain('100 of 100');
    expect(remedy).toContain('does not reset');
    expect(remedy).not.toContain('try again');
  });

  it('classifies a ceiling that carries NO details, from the message alone', () => {
    // Endpoints and organizations attach prose only — see HANDOFF.md.
    const failure = classifyWriteError(
      error(
        409,
        'conflict',
        'This project already has 500 endpoints, which is the maximum. Delete one you no longer deliver to.',
      ),
    );

    expect(failure).toMatchObject({ kind: 'ceiling', limit: null, current: null });
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

  it('gives the two failures different headlines', () => {
    const throttled = classifyWriteError(error(429, 'rate_limited', 'Too many attempts.'));
    const ceiling = classifyWriteError(
      error(409, 'conflict', 'You already own 10 organizations, which is the limit.'),
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
