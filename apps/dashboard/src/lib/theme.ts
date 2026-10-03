import { create } from 'zustand';

/**
 * Light / dark / follow-the-system, chosen by the person and remembered.
 *
 * Before this, `main.tsx` read `prefers-color-scheme` once and there was no
 * control anywhere in the product — so anyone whose OS was dark got a
 * near-black page (`--c-canvas: 12 12 14`) with no way to say otherwise, on the
 * sign-in screen most of all, where there is no account menu to put a setting
 * in.
 *
 * ## Why localStorage, given the note this replaces
 *
 * The old comment said a per-user preference "belongs in account settings once
 * that endpoint exists, not in localStorage guesswork". The guesswork was the
 * problem, not the storage: inferring a preference nobody stated. An explicit
 * choice is different, and it is a per-DEVICE display setting — the same
 * person reasonably wants dark on the laptop at 2am and light on the office
 * monitor, which an account-level field would actively get wrong. It also has
 * to work signed out, where there is no account to read.
 *
 * ## First paint
 *
 * The `data-theme` attribute is set by an inline script in `index.html`, which
 * runs before the stylesheet paints and therefore before anything is visible.
 * Doing it here instead would flash the light palette on every load for a dark
 * user, because a module script is deferred until after the document parses.
 * That script and `THEME_STORAGE_KEY` have to agree; both say so.
 */

/** Must match the key in the inline bootstrap script in `index.html`. */
export const THEME_STORAGE_KEY = 'hookubit.theme.v1';

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_PREFERENCES: readonly ThemePreference[] = ['system', 'light', 'dark'];

function isPreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark';
}

/**
 * What the page should actually render, given the stated preference and what
 * the OS is asking for. Pure, because it is the only part worth testing and
 * this workspace has no DOM.
 */
export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  if (preference === 'system') return systemPrefersDark ? 'dark' : 'light';
  return preference;
}

/**
 * The stored choice, or `system` when there is none.
 *
 * Guarded like `tour-storage`: `localStorage` does not merely come back empty
 * in a private window or with site data blocked — THE ACCESSOR ITSELF THROWS.
 * An unguarded read here would take down the whole app for anyone browsing
 * privately, and the failure mode of "cannot tell" is simply to follow the OS,
 * which is what someone who never chose would have got anyway.
 */
export function readThemePreference(): ThemePreference {
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isPreference(raw) ? raw : 'system';
  } catch {
    return 'system';
  }
}

export function writeThemePreference(preference: ThemePreference): void {
  try {
    if (preference === 'system') window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Nothing to do and nothing to tell the user: the theme still applies for
    // this page, it just will not survive a reload.
  }
}

function systemPrefersDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

/**
 * `data-theme` is only ever SET for dark, and removed for light, because
 * `index.css` declares light on bare `:root` and dark under
 * `:root[data-theme='dark']`. Writing `data-theme="light"` would work by
 * accident today and break the moment a `prefers-color-scheme` block is added.
 */
function applyTheme(resolved: ResolvedTheme): void {
  if (resolved === 'dark') document.documentElement.dataset.theme = 'dark';
  else delete document.documentElement.dataset.theme;
}

interface ThemeState {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
  /** Starts following the OS while the preference is `system`. Returns an unsubscribe. */
  listenToSystem: () => () => void;
}

export const useThemeStore = create<ThemeState>((set, get) => {
  const preference = typeof window === 'undefined' ? 'system' : readThemePreference();
  const resolved =
    typeof window === 'undefined' ? 'light' : resolveTheme(preference, systemPrefersDark());

  return {
    preference,
    resolved,

    setPreference: (next) => {
      writeThemePreference(next);
      const applied = resolveTheme(next, systemPrefersDark());
      applyTheme(applied);
      set({ preference: next, resolved: applied });
    },

    listenToSystem: () => {
      const query = window.matchMedia('(prefers-color-scheme: dark)');
      const onChange = (event: MediaQueryListEvent) => {
        // Only while nothing has been chosen. Someone who picked `light` means
        // it, including when their OS flips at sunset.
        if (get().preference !== 'system') return;
        const applied = resolveTheme('system', event.matches);
        applyTheme(applied);
        set({ resolved: applied });
      };
      query.addEventListener('change', onChange);
      return () => query.removeEventListener('change', onChange);
    },
  };
});
