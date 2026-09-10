import { describe, expect, it } from 'vitest';
import { ApiRequestError } from '../../lib/api';
import { fieldNamedByServer, isForbidden, placeServerErrors } from './write-errors';

const FIELDS = ['initial_delay_ms', 'max_delay_ms', 'multiplier'] as const;
type Field = (typeof FIELDS)[number];

function capture() {
  const errors: Record<string, string> = {};
  const focused: string[] = [];
  return {
    errors,
    focused,
    setError: (field: Field, error: { message: string }) => {
      errors[field] = error.message;
    },
    setFocus: (field: Field) => focused.push(field),
  };
}

describe('placeServerErrors', () => {
  it('places a ValidationPipe array under each named input and focuses the first', () => {
    const error = new ApiRequestError(400, {
      code: 'invalid_request',
      message: ['max_delay_ms: must not be less than 1', 'multiplier: must not be greater than 100'],
    });
    const form = capture();
    const claimed = placeServerErrors(error, FIELDS, form.setError, form.setFocus);

    expect(claimed).toEqual(['max_delay_ms', 'multiplier']);
    expect(form.errors.max_delay_ms).toBe('must not be less than 1');
    expect(form.focused).toEqual(['max_delay_ms']);
  });

  it('places a service-level AppError under the field in details, since its message has no prefix', () => {
    const error = new ApiRequestError(400, {
      code: 'invalid_request',
      message:
        'initial_delay_ms (10000) must not exceed max_delay_ms (5000); every retry would be clamped to the ceiling.',
      details: { field: 'initial_delay_ms' },
    });
    const form = capture();
    const claimed = placeServerErrors(error, FIELDS, form.setError, form.setFocus);

    expect(claimed).toEqual(['initial_delay_ms']);
    expect(form.errors.initial_delay_ms).toContain('must not exceed max_delay_ms');
  });

  it('claims nothing for a field the form does not render, so the panel still shows it', () => {
    const error = new ApiRequestError(400, {
      code: 'invalid_request',
      message: 'replacement_id cannot be the policy being deleted.',
      details: { field: 'replacement_id' },
    });
    const form = capture();
    expect(placeServerErrors(error, FIELDS, form.setError, form.setFocus)).toEqual([]);
    expect(form.focused).toEqual([]);
  });

  it('claims nothing for a conflict or a ceiling — those are not field errors', () => {
    const conflict = new ApiRequestError(409, { code: 'conflict', message: 'In use.' });
    const form = capture();
    expect(placeServerErrors(conflict, FIELDS, form.setError, form.setFocus)).toEqual([]);
  });
});

describe('fieldNamedByServer', () => {
  it('reads details.field only when it is a non-empty string', () => {
    expect(
      fieldNamedByServer(
        new ApiRequestError(400, { code: 'invalid_request', message: 'x', details: { field: 'burst' } }),
      ),
    ).toBe('burst');
    expect(
      fieldNamedByServer(
        new ApiRequestError(400, { code: 'invalid_request', message: 'x', details: { field: 3 } }),
      ),
    ).toBeNull();
    expect(fieldNamedByServer(new Error('network'))).toBeNull();
  });
});

describe('isForbidden', () => {
  it('matches a 403 by status or by code, and nothing else', () => {
    expect(isForbidden(new ApiRequestError(403, { code: 'forbidden', message: 'no' }))).toBe(true);
    expect(isForbidden(new ApiRequestError(409, { code: 'conflict', message: 'no' }))).toBe(false);
    expect(isForbidden(new Error('no'))).toBe(false);
  });
});
