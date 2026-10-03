import { describe, expect, it } from 'vitest';
import {
  formatPayloadFilterInput,
  parsePayloadFilterInput,
  validatePayloadFilterInput,
} from './payload-filter';

describe('parsePayloadFilterInput', () => {
  it('reads blank text as "no filter" — null, which is how the field is cleared', () => {
    expect(parsePayloadFilterInput('')).toEqual({ ok: true, value: null });
    expect(parsePayloadFilterInput('  \n ')).toEqual({ ok: true, value: null });
  });

  it('accepts a JSON object', () => {
    expect(parsePayloadFilterInput('{ "data.currency": "GHS" }')).toEqual({
      ok: true,
      value: { 'data.currency': 'GHS' },
    });
  });

  it('refuses text that is not JSON', () => {
    expect(parsePayloadFilterInput('{ currency: GHS }')).toEqual({
      ok: false,
      reason: 'This is not valid JSON.',
    });
  });

  it('refuses JSON that is not an object — an array, a string, null', () => {
    expect(parsePayloadFilterInput('[1]').ok).toBe(false);
    expect(parsePayloadFilterInput('"GHS"').ok).toBe(false);
    // `null` typed as text is not the same as leaving the field blank: the
    // operator probably meant something and should say it by clearing the box.
    expect(parsePayloadFilterInput('null').ok).toBe(false);
  });

  it('refuses the empty object, because it would match every payload', () => {
    expect(validatePayloadFilterInput('{}')).toMatch(/match every payload/);
  });

  it('refuses a predicate over the serialised size limit', () => {
    const big = JSON.stringify({ 'data.note': 'x'.repeat(5_000) });
    expect(validatePayloadFilterInput(big)).toMatch(/the maximum is 4096/);
  });

  it('formats null as an empty textarea and an object pretty-printed', () => {
    expect(formatPayloadFilterInput(null)).toBe('');
    expect(formatPayloadFilterInput({ a: 1 })).toBe('{\n  "a": 1\n}');
  });
});
