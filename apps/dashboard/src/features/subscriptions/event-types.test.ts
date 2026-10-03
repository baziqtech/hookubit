import { describe, expect, it } from 'vitest';
import { MAX_EVENT_TYPES_PER_SUBSCRIPTION, MAX_EVENT_TYPE_LENGTH } from '../../types/api';
import {
  formatEventTypesInput,
  parseEventTypesInput,
  rejectEventTypePattern,
  rejectEventTypes,
  validateEventTypesInput,
} from './event-types';

/**
 * A mirror of control-api `event-type-pattern.spec.ts`, in the cases that a
 * form can reach. The point of every refusal is the same: a pattern is stored
 * exactly as typed or not at all. Nothing in here may pass a value the server
 * would rewrite, and nothing may rewrite a value itself.
 */
describe('rejectEventTypePattern — the three accepted forms', () => {
  it('accepts "*" on its own', () => {
    expect(rejectEventTypePattern('*')).toBeNull();
  });

  it('accepts a trailing ".*" prefix filter', () => {
    expect(rejectEventTypePattern('payment.*')).toBeNull();
    expect(rejectEventTypePattern('payment.card.*')).toBeNull();
  });

  it('accepts an exact, dot-separated type', () => {
    expect(rejectEventTypePattern('payment.settled')).toBeNull();
    expect(rejectEventTypePattern('payment_v2.card-captured')).toBeNull();
    expect(rejectEventTypePattern('ping')).toBeNull();
  });
});

describe('rejectEventTypePattern — refusals, never rewrites', () => {
  it('refuses ".*" — an empty prefix would match only types beginning with a dot', () => {
    expect(rejectEventTypePattern('.*')).toMatch(/write "\*" if you mean everything/);
  });

  it('refuses a "*" anywhere but the two sanctioned shapes — the silent-nothing case', () => {
    // The router falls through to exact equality on these, so `pay*` would
    // match the literal type `pay*` and never fire.
    expect(rejectEventTypePattern('pay*')).toMatch(/would never fire/);
    expect(rejectEventTypePattern('*.settled')).toMatch(/would never fire/);
    expect(rejectEventTypePattern('*.*')).toMatch(/has a "\*" inside the prefix/);
    expect(rejectEventTypePattern('pay*.*')).toMatch(/has a "\*" inside the prefix/);
  });

  it('refuses whitespace rather than trimming it — the router compares bytes', () => {
    expect(rejectEventTypePattern('payment.settled ')).toMatch(/byte for byte/);
    expect(rejectEventTypePattern(' payment.settled')).toMatch(/byte for byte/);
  });

  it('refuses an interior space as an invalid segment', () => {
    expect(rejectEventTypePattern('payment settled')).toMatch(/not a valid segment/);
  });

  it('refuses empty segments — "..", a leading or a trailing dot', () => {
    expect(rejectEventTypePattern('payment..settled')).toMatch(/empty segment/);
    expect(rejectEventTypePattern('.payment')).toMatch(/empty segment/);
    expect(rejectEventTypePattern('payment.')).toMatch(/empty segment/);
  });

  it('refuses characters outside letters, digits, "_" and "-"', () => {
    expect(rejectEventTypePattern('payment.settled!')).toMatch(/not a valid segment/);
    expect(rejectEventTypePattern('payment/settled')).toMatch(/not a valid segment/);
  });

  it('refuses more than eight segments', () => {
    expect(rejectEventTypePattern('a.b.c.d.e.f.g.h.i')).toMatch(/9 dot-separated segments/);
    expect(rejectEventTypePattern('a.b.c.d.e.f.g.h')).toBeNull();
  });

  it('refuses an empty string and an over-long one', () => {
    expect(rejectEventTypePattern('')).toBe('is empty');
    expect(rejectEventTypePattern('a'.repeat(MAX_EVENT_TYPE_LENGTH + 1))).toMatch(
      /the maximum is 255/,
    );
  });

  it('refuses a non-string', () => {
    expect(rejectEventTypePattern(42)).toBe('must be a string');
  });
});

describe('rejectEventTypes — the list-level rules', () => {
  it('accepts a list of exact types and prefixes', () => {
    expect(rejectEventTypes(['payment.settled', 'payout.*'])).toBeNull();
  });

  it('accepts ["*"] on its own', () => {
    expect(rejectEventTypes(['*'])).toBeNull();
  });

  it('refuses an empty list and names both alternatives', () => {
    const reason = rejectEventTypes([]);
    expect(reason).toMatch(/must not be empty/);
    expect(reason).toMatch(/\["\*"\]/);
    expect(reason).toMatch(/enabled=false/);
  });

  it('refuses "*" alongside other patterns — the row would read as filtered and receive everything', () => {
    expect(rejectEventTypes(['*', 'payment.settled'])).toMatch(/alongside other patterns/);
    expect(rejectEventTypes(['payment.settled', '*'])).toMatch(/alongside other patterns/);
  });

  it('refuses duplicates rather than de-duplicating them', () => {
    expect(rejectEventTypes(['payment.settled', 'payment.settled'])).toBe(
      'event_types[1] repeats "payment.settled"',
    );
  });

  it('names the index of the first bad pattern', () => {
    expect(rejectEventTypes(['payment.settled', 'pay*'])).toMatch(/^event_types\[1\] contains "\*"/);
  });

  it('refuses more than the ceiling', () => {
    const many = Array.from({ length: MAX_EVENT_TYPES_PER_SUBSCRIPTION + 1 }, (_, i) => `t${i}`);
    expect(rejectEventTypes(many)).toMatch(/101 entries; the maximum is 100/);
  });

  it('refuses a non-array', () => {
    expect(rejectEventTypes(null)).toBe('event_types must be an array of strings');
  });
});

describe('parseEventTypesInput — the textarea', () => {
  it('splits on newlines', () => {
    expect(parseEventTypesInput('payment.settled\npayment.failed')).toEqual([
      'payment.settled',
      'payment.failed',
    ]);
  });

  it('splits on commas, with or without spaces around them', () => {
    expect(parseEventTypesInput('payment.settled, payment.failed,payout.*')).toEqual([
      'payment.settled',
      'payment.failed',
      'payout.*',
    ]);
  });

  it('drops blank lines and a trailing newline', () => {
    expect(parseEventTypesInput('payment.settled\n\n\npayment.failed\n')).toEqual([
      'payment.settled',
      'payment.failed',
    ]);
  });

  it('does NOT trim an interior space — that is left for the validator to name', () => {
    expect(parseEventTypesInput('payment settled')).toEqual(['payment settled']);
    expect(validateEventTypesInput('payment settled')).toMatch(/not a valid segment/);
  });

  it('round-trips through formatEventTypesInput', () => {
    const stored = ['payment.settled', 'payout.*'];
    expect(parseEventTypesInput(formatEventTypesInput(stored))).toEqual(stored);
  });

  it('validateEventTypesInput answers true for a storable list and the sentence otherwise', () => {
    expect(validateEventTypesInput('payment.settled\npayout.*')).toBe(true);
    expect(validateEventTypesInput('')).toMatch(/must not be empty/);
    expect(validateEventTypesInput('*, payment.settled')).toMatch(/alongside other patterns/);
  });
});
