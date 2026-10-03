import { describe, expect, it } from 'vitest';
import { DEFAULT_WINDOW_HOURS, MAX_WINDOW_HOURS } from '../../types/api';
import {
  ANALYTICS_WINDOWS,
  DEFAULT_WINDOW_MATCHES_API,
  hoursFor,
  parseWindowKey,
} from './window';

describe('analytics windows', () => {
  it('maps the three shorthands to the hour counts the API documents', () => {
    expect(hoursFor('24h')).toBe(24);
    expect(hoursFor('7d')).toBe(168);
    expect(hoursFor('30d')).toBe(720);
  });

  it('never offers a window the API would refuse', () => {
    for (const window of ANALYTICS_WINDOWS) {
      expect(window.hours).toBeGreaterThanOrEqual(1);
      expect(window.hours).toBeLessThanOrEqual(MAX_WINDOW_HOURS);
    }
  });

  it('opens on the same default the API applies when window_hours is omitted', () => {
    expect(DEFAULT_WINDOW_MATCHES_API).toBe(true);
    expect(hoursFor(parseWindowKey(null))).toBe(DEFAULT_WINDOW_HOURS);
  });

  it('treats an unknown ?window= as the default rather than an error', () => {
    expect(parseWindowKey('90d')).toBe('24h');
    expect(parseWindowKey('')).toBe('24h');
    expect(parseWindowKey(undefined)).toBe('24h');
    expect(parseWindowKey('7d')).toBe('7d');
  });
});
