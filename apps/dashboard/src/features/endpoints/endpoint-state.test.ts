import { describe, expect, it } from 'vitest';
import { endpointFacts } from './endpoint-state';

const endpoint = (over: Partial<Parameters<typeof endpointFacts>[0]> = {}) =>
  endpointFacts({ status: 'active', enabled: true, has_live_secret: true, ...over });

describe('endpointFacts', () => {
  it('a working endpoint says so on both sides and offers no fix', () => {
    const facts = endpoint();
    expect(facts.intent.label).toBe('On');
    expect(facts.platform.label).toBe('Delivering');
    expect(facts.source).toBe('none');
    expect(facts.remedy).toBeNull();
  });

  it('separates "we stopped it" from "you paused it"', () => {
    // The whole point of two columns. These are different problems with
    // different fixes, and one amber badge cannot say which.
    const stopped = endpoint({ status: 'disabled' });
    expect(stopped.intent.label).toBe('On');
    expect(stopped.platform.label).toBe('Stopped by us');
    expect(stopped.source).toBe('platform');

    const paused = endpoint({ enabled: false });
    expect(paused.intent.label).toBe('Paused by you');
    expect(paused.platform.label).toBe('Not sending');
    expect(paused.source).toBe('yours');
  });

  it('a missing secret outranks the breaker, because Resume would 409', () => {
    // An endpoint with no live secret cannot be enabled at all. Naming the
    // breaker first would put a button on screen that is guaranteed to fail.
    const facts = endpoint({ status: 'disabled', has_live_secret: false });
    expect(facts.platform.label).toBe('No secret yet');
    expect(facts.remedy).toContain('signing secret');
  });

  it('an operator pause outranks a missing secret', () => {
    // Resuming is not the next step either way, and "Paused by you" is the
    // fact the operator can act on without asking anyone for a secret.
    const facts = endpoint({ enabled: false, has_live_secret: false });
    expect(facts.intent.label).toBe('Paused by you');
  });

  it('a deleted endpoint offers nothing, because every write against it 409s', () => {
    const facts = endpoint({ status: 'deleted' });
    expect(facts.platform.label).toBe('Kept for the record');
    expect(facts.remedy).toBeNull();
  });

  it('treats status paused as paused even when enabled disagrees', () => {
    expect(endpoint({ status: 'paused' }).intent.label).toBe('Paused by you');
  });
});
