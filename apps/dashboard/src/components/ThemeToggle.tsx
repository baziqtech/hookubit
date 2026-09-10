import { useEffect } from 'react';
import { cn } from '../lib/cn';
import { THEME_PREFERENCES, useThemeStore, type ThemePreference } from '../lib/theme';

const LABELS: Record<ThemePreference, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};

/**
 * Three words in a segmented control: System, Light, Dark.
 *
 * Words rather than a sun/moon icon pair, because an icon toggle can only
 * express two states and the third — "follow the OS" — is the default and the
 * one worth being able to return to. It is also the state a user cannot infer
 * from a half-lit moon.
 *
 * `radiogroup` rather than a row of buttons: these are three mutually
 * exclusive settings, so arrow keys should move between them and a screen
 * reader should hear "2 of 3". A `<fieldset>` with real inputs would be the
 * other correct answer; this is smaller and the roles carry the same meaning.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const preference = useThemeStore((state) => state.preference);
  const setPreference = useThemeStore((state) => state.setPreference);
  const listenToSystem = useThemeStore((state) => state.listenToSystem);

  // While the preference is `system`, an OS that flips at sunset should take
  // the page with it without a reload.
  useEffect(() => listenToSystem(), [listenToSystem]);

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className={cn(
        'inline-flex items-center gap-0.5 rounded-full border border-line bg-panel p-0.5',
        className,
      )}
    >
      {THEME_PREFERENCES.map((value) => {
        const selected = preference === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => setPreference(value)}
            className={cn(
              'rounded-full px-2.5 py-1 text-2xs font-medium transition-colors',
              selected
                ? 'bg-accent text-accent-ink'
                : 'text-ink-subtle hover:bg-raised hover:text-ink',
            )}
          >
            {LABELS[value]}
          </button>
        );
      })}
    </div>
  );
}
