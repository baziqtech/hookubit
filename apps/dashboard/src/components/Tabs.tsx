import { useCallback, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface TabItem {
  value: string;
  label: ReactNode;
  /** Right-hand count, e.g. attempts on a delivery. */
  badge?: ReactNode;
  disabled?: boolean;
}

export interface TabsProps {
  items: TabItem[];
  value: string;
  onChange: (value: string) => void;
  /** Panel content for the active tab; wired to the tab with aria-controls. */
  children?: ReactNode;
  className?: string;
  'aria-label': string;
}

/**
 * WAI-ARIA tabs with manual activation: Arrow keys move focus, Enter/Space
 * selects. Manual rather than automatic activation because the panels here
 * fetch — auto-activating on arrow-through would fire a request per keypress.
 */
export function Tabs({
  items,
  value,
  onChange,
  children,
  className,
  'aria-label': ariaLabel,
}: TabsProps) {
  const baseId = useId();
  const listRef = useRef<HTMLDivElement>(null);

  const focusTab = useCallback((index: number) => {
    const tabs = listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)');
    if (!tabs?.length) return;
    const bounded = (index + tabs.length) % tabs.length;
    tabs[bounded]?.focus();
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const enabled = items.filter((item) => !item.disabled);
    const current = enabled.findIndex((item) => item.value === value);
    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault();
        focusTab(current + 1);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        focusTab(current - 1);
        break;
      case 'Home':
        event.preventDefault();
        focusTab(0);
        break;
      case 'End':
        event.preventDefault();
        focusTab(enabled.length - 1);
        break;
      default:
        break;
    }
  };

  return (
    <div className={className}>
      <div
        ref={listRef}
        role="tablist"
        aria-label={ariaLabel}
        onKeyDown={onKeyDown}
        className="flex items-center gap-0.5 border-b border-line"
      >
        {items.map((item) => {
          const selected = item.value === value;
          return (
            <button
              key={item.value}
              role="tab"
              type="button"
              id={`${baseId}-tab-${item.value}`}
              aria-selected={selected}
              aria-controls={`${baseId}-panel-${item.value}`}
              // Roving tabindex: one stop in the tab order for the whole set.
              tabIndex={selected ? 0 : -1}
              disabled={item.disabled}
              onClick={() => onChange(item.value)}
              className={cn(
                '-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-xs font-medium',
                'transition-colors disabled:pointer-events-none disabled:opacity-40',
                selected
                  ? 'border-accent text-ink'
                  : 'border-transparent text-ink-muted hover:border-line-strong hover:text-ink',
              )}
            >
              {item.label}
              {item.badge !== undefined && (
                <span className="rounded bg-raised px-1 py-px text-2xs tabular text-ink-subtle">
                  {item.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {children !== undefined && (
        <div
          role="tabpanel"
          id={`${baseId}-panel-${value}`}
          aria-labelledby={`${baseId}-tab-${value}`}
          tabIndex={0}
          className="focus-visible:outline-none"
        >
          {children}
        </div>
      )}
    </div>
  );
}
