import { useSearchParams } from 'react-router-dom';
import { cn } from '../../lib/cn';
import {
  ANALYTICS_WINDOWS,
  DEFAULT_WINDOW_KEY,
  parseWindowKey,
  windowFor,
  type AnalyticsWindowKey,
} from './window';

/**
 * A group of pressed/unpressed buttons rather than tabs: the panels below are
 * not tab panels, and the value is a URL parameter that survives a reload and
 * a paste into an incident channel.
 */
export function WindowSelector({
  value,
  onChange,
  className,
}: {
  value: AnalyticsWindowKey;
  onChange: (key: AnalyticsWindowKey) => void;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label="Window"
      className={cn('flex rounded-[0.4375rem] bg-sunken p-0.5', className)}
    >
      {ANALYTICS_WINDOWS.map((window) => {
        const active = window.key === value;
        return (
          <button
            key={window.key}
            type="button"
            aria-pressed={active}
            title={window.label}
            onClick={() => onChange(window.key)}
            className={cn(
              'h-6 rounded-[0.3125rem] px-2.5 text-xs transition-colors',
              active
                ? 'bg-panel font-semibold text-ink shadow-panel'
                : 'font-medium text-ink-muted hover:text-ink',
            )}
          >
            {window.key}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The window, read from and written to `?window=`.
 *
 * A hook rather than local state, because two pages now carry this control and
 * both of them have the same requirement: a link someone pastes at 2am has to
 * open on the window they were looking at. The default is removed from the URL
 * rather than written to it, so the common case has a clean address.
 */
export function useAnalyticsWindow() {
  const [searchParams, setSearchParams] = useSearchParams();
  const key = parseWindowKey(searchParams.get('window'));

  const setKey = (next: AnalyticsWindowKey) => {
    const params = new URLSearchParams(searchParams);
    if (next === DEFAULT_WINDOW_KEY) params.delete('window');
    else params.set('window', next);
    setSearchParams(params, { replace: true });
  };

  return { key, window: windowFor(key), setKey };
}
