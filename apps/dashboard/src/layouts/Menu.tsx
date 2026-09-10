import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface MenuProps {
  /** The trigger's visible content. */
  trigger: ReactNode;
  label: string;
  /**
   * Which way the popover opens. The account menu sits at the FOOT of a
   * sidebar that is exactly one viewport tall, so opening downward put "Sign
   * out" below the fold on a 720px-high window, where nothing could scroll to
   * it: the sidebar is sticky and its own height. Menus at the top of the
   * sidebar keep the default.
   */
  placement?: 'bottom' | 'top';
  children: (close: () => void) => ReactNode;
  align?: 'left' | 'right';
  className?: string;
  triggerClassName?: string;
}

/**
 * Small popover menu used by the switchers in the shell. Deliberately not a
 * dependency: it needs outside-click, Escape, and `aria-expanded`, and that is
 * the whole requirement — the items inside are links, so the browser already
 * provides tab order and activation.
 */
export function Menu({
  trigger,
  label,
  placement = 'bottom',
  children,
  align = 'left',
  className,
  triggerClassName,
}: MenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      // Return focus to the trigger, or the keyboard user is stranded.
      triggerRef.current?.focus();
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((current) => !current)}
        className={cn(
          'flex w-full items-center gap-2 rounded-md border border-transparent px-2 py-1.5',
          'text-left text-xs transition-colors hover:bg-raised',
          open && 'bg-raised',
          triggerClassName,
        )}
      >
        {trigger}
        <svg
          className="ml-auto h-3 w-3 shrink-0 text-ink-subtle"
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden="true"
        >
          <path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          aria-label={label}
          className={cn(
            'absolute z-40 min-w-[15rem] animate-pop-in rounded-lg border border-line',
            placement === 'top' ? 'bottom-full mb-1' : 'mt-1',
            'bg-panel p-1 shadow-pop',
            align === 'right' ? 'right-0' : 'left-0',
          )}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <p className="px-2 py-1 text-2xs font-medium uppercase tracking-wider text-ink-subtle">
      {children}
    </p>
  );
}
