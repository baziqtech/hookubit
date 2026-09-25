import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readTourRecord, shouldAutoOpenTour, writeTourRecord } from './tour-storage';
import { useTourStore } from './tour-store';

/**
 * vitest runs in node here — there is no `window` — which is exactly the
 * "storage throws" case the reads are guarded against. A stub supplies a
 * working store for the cases that need one, and its absence is a case too.
 */
function stubStorage() {
  const map = new Map<string, string>();
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
    },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('shouldAutoOpenTour', () => {
  it('never opens once the server has a completion, whatever this browser remembers', () => {
    stubStorage();
    expect(shouldAutoOpenTour('2026-09-08T14:20:00.000Z')).toBe(false);
    writeTourRecord('skipped');
    expect(shouldAutoOpenTour('2026-09-08T14:20:00.000Z')).toBe(false);
  });

  it('opens for a user the server has no completion for and this browser has no record for', () => {
    stubStorage();
    expect(shouldAutoOpenTour(null)).toBe(true);
  });

  it('falls back to the local record only while the server still says null', () => {
    stubStorage();
    writeTourRecord('completed');
    expect(readTourRecord()).toBe('completed');
    // The POST has not landed (or failed): the browser record holds the line.
    expect(shouldAutoOpenTour(null)).toBe(false);
  });

  it('reads "cannot tell" as "never seen" when storage is unavailable', () => {
    // No window at all: the accessor throws, and the guard must swallow it.
    expect(readTourRecord()).toBeNull();
    expect(() => writeTourRecord('skipped')).not.toThrow();
    expect(shouldAutoOpenTour(null)).toBe(true);
  });
});

describe('tour store auto-open', () => {
  beforeEach(() => {
    stubStorage();
    useTourStore.setState({ open: false, step: 3, autoOpenChecked: false });
  });

  it('opens at step 1 for a new user and evaluates exactly once', () => {
    const { maybeAutoOpen } = useTourStore.getState();
    maybeAutoOpen(null);
    expect(useTourStore.getState()).toMatchObject({ open: true, step: 0, autoOpenChecked: true });

    // A later session refetch delivering a timestamp must not close a tour in progress.
    maybeAutoOpen('2026-09-08T14:20:00.000Z');
    expect(useTourStore.getState().open).toBe(true);
  });

  it('stays closed for a user whose completion the server already holds', () => {
    useTourStore.getState().maybeAutoOpen('2026-09-08T14:20:00.000Z');
    expect(useTourStore.getState()).toMatchObject({ open: false, autoOpenChecked: true });
  });

  it('records skip and complete locally as the in-flight fallback', () => {
    useTourStore.getState().maybeAutoOpen(null);
    useTourStore.getState().skip();
    expect(useTourStore.getState().open).toBe(false);
    expect(readTourRecord()).toBe('skipped');

    useTourStore.getState().openTour();
    useTourStore.getState().complete();
    expect(readTourRecord()).toBe('completed');
  });
});
