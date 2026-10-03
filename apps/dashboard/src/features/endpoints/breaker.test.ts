import { describe, expect, it } from 'vitest';
import type { Endpoint } from '../../types/api';
import { endpointCondition, endpointControls } from './breaker';

const endpoint = (over: Partial<Pick<Endpoint, 'enabled' | 'status'>>) => ({
  enabled: true,
  status: 'active' as Endpoint['status'],
  ...over,
});

/**
 * The delivery page can say "no retry will run — the circuit breaker has
 * disabled this endpoint". Putting a button next to that sentence is only an
 * improvement if the button tells the truth: nothing about re-enabling repairs
 * the consumer whose failures opened the breaker.
 *
 * If this suite goes green while the control reads "Enable" or "Fix", the
 * product is inviting an operator to believe an incident is over.
 */
describe('endpointCondition', () => {
  it('separates the breaker’s verdict from a person’s decision', () => {
    // `enabled: true` with a `disabled` status is the platform overruling
    // intent — the operator still wants this endpoint delivering.
    expect(endpointCondition(endpoint({ enabled: true, status: 'disabled' }))).toBe(
      'auto_disabled',
    );
    expect(endpointCondition(endpoint({ enabled: false, status: 'paused' }))).toBe(
      'operator_paused',
    );
    expect(endpointCondition(endpoint({ enabled: true, status: 'active' }))).toBe('delivering');
  });

  it('treats deleted as its own state, not as paused', () => {
    // Every write against a soft-deleted endpoint answers 409. Reading it as
    // "paused" would offer a resume button that cannot succeed.
    expect(endpointCondition(endpoint({ enabled: false, status: 'deleted' }))).toBe('deleted');
    expect(endpointCondition(endpoint({ enabled: true, status: 'deleted' }))).toBe('deleted');
  });

  it('does not read an enabled-but-paused endpoint as delivering', () => {
    expect(endpointCondition(endpoint({ enabled: true, status: 'paused' }))).toBe('auto_disabled');
  });
});

describe('endpointControls', () => {
  it('never lets the breaker case imply anything has been fixed', () => {
    const controls = endpointControls(endpoint({ enabled: true, status: 'disabled' }));

    expect(controls.resumeLabel).toBe('Resume deliveries anyway');
    expect(controls.resumeConfirmLabel).toBe('Resume anyway');
    expect(controls.resumeIsRisky).toBe(true);
    // The words that would claim a repair.
    expect(controls.resumeLabel).not.toMatch(/fix|restore|repair|re-?enable/i);
  });

  it('offers pausing as the honest alternative when the breaker opened', () => {
    // Pausing converts a platform verdict into a recorded operator decision
    // with a reason, and stops the retry churn.
    expect(endpointControls(endpoint({ enabled: true, status: 'disabled' })).pauseLabel).toBe(
      'Pause it instead',
    );
  });

  it('reverses a person’s own pause as an ordinary action', () => {
    const controls = endpointControls(endpoint({ enabled: false, status: 'paused' }));

    expect(controls.resumeLabel).toBe('Resume deliveries');
    expect(controls.resumeIsRisky).toBe(false);
    // There is nothing to pause; offering it would be a control that does
    // nothing.
    expect(controls.pauseLabel).toBeNull();
  });

  it('offers only pausing while the endpoint is delivering', () => {
    const controls = endpointControls(endpoint({ enabled: true, status: 'active' }));
    expect(controls.resumeLabel).toBeNull();
    expect(controls.pauseLabel).toBe('Pause deliveries');
  });

  it('offers nothing at all on a deleted endpoint', () => {
    const controls = endpointControls(endpoint({ enabled: false, status: 'deleted' }));
    expect(controls.resumeLabel).toBeNull();
    expect(controls.pauseLabel).toBeNull();
  });

  it('gives the two resume paths different wording end to end', () => {
    const breaker = endpointControls(endpoint({ enabled: true, status: 'disabled' }));
    const paused = endpointControls(endpoint({ enabled: false, status: 'paused' }));

    expect(breaker.resumeLabel).not.toBe(paused.resumeLabel);
    expect(breaker.resumeTitle).not.toBe(paused.resumeTitle);
    expect(breaker.resumeConfirmLabel).not.toBe(paused.resumeConfirmLabel);
  });
});
