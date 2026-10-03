import { describe, expect, it } from 'vitest';
import { resolveTheme, THEME_PREFERENCES } from './theme';

/**
 * The pure half of the theme. Reading and writing `localStorage` and touching
 * `documentElement` need a DOM, which this workspace deliberately does not
 * have; what is worth pinning is the decision itself.
 */
describe('resolveTheme', () => {
  it('follows the OS only while the preference is `system`', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });

  it('ignores the OS once a person has chosen — in BOTH directions', () => {
    // The direction that matters: someone who picked light means it at
    // sunset, when the OS flips underneath them.
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('resolves every preference to a real theme, never to `system`', () => {
    for (const preference of THEME_PREFERENCES) {
      for (const prefersDark of [true, false]) {
        expect(['light', 'dark']).toContain(resolveTheme(preference, prefersDark));
      }
    }
  });

  it('offers system first, because it is the default and the way back', () => {
    expect(THEME_PREFERENCES[0]).toBe('system');
  });
});
