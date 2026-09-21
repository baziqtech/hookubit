import { useEffect, type ReactNode } from 'react';
import { cn } from '../lib/cn';
import { THEME_PREFERENCES, useThemeStore, type ThemePreference } from '../lib/theme';

const LABELS: Record<ThemePreference, string> = {
  system: 'Match my system',
  light: 'Light',
  dark: 'Dark',
};

const GLYPHS: Record<ThemePreference, ReactNode> = {
  // A monitor: the thing whose setting is being followed.
  system: (
    <>
      <rect x="2.5" y="4" width="19" height="12" rx="2" />
      <path d="M8.5 20h7M12 16v4" />
    </>
  ),
  light: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M21.5 12h-2M4.5 12h-2M18.4 5.6l-1.4 1.4M7 17l-1.4 1.4M18.4 18.4 17 17M7 7 5.6 5.6" />
    </>
  ),
  dark: <path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11Z" />,
};

/**
 * Three segments: follow the system, light, dark.
 *
 * ## Why three icons rather than one toggle, or three words
 *
 * A sun/moon TOGGLE can only express two states, and the third — "follow the
 * OS" — is the default and the one worth being able to return to. That is the
 * argument that put three words here originally, and it was right about the
 * toggle and wrong about icons: a segmented control showing all three at once
 * has no hidden state to infer, because every option is on screen with the
 * chosen one lit. Icons then cost a third of the width, which is what lets this
 * sit in the topbar beside a breadcrumb instead of inside a menu.
 *
 * Each segment still carries its full name as its accessible label, so nothing
 * is lost to anyone reading with a screen reader or hovering for a tooltip.
 *
 * ## Why radiogroup
 *
 * These are three mutually exclusive settings, so arrow keys should move
 * between them and a screen reader should hear "2 of 3". A `<fieldset>` with
 * real inputs would be the other correct answer; this is smaller and the roles
 * carry the same meaning.
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
      className={cn('inline-flex items-center gap-px rounded-[0.4375rem] bg-sunken p-0.5', className)}
    >
      {THEME_PREFERENCES.map((value) => {
        const selected = preference === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={LABELS[value]}
            title={LABELS[value]}
            onClick={() => setPreference(value)}
            className={cn(
              'flex h-6 flex-1 items-center justify-center rounded-[0.3125rem] px-2.5 transition-colors',
              selected
                ? 'bg-panel text-ink shadow-panel'
                : 'text-ink-subtle hover:text-ink-muted',
            )}
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              className="h-3.5 w-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {GLYPHS[value]}
            </svg>
          </button>
        );
      })}
    </div>
  );
}
