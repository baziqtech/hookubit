import { useEffect, useRef, type ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  /** Footer actions, right-aligned. */
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}

const SIZES = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-3xl' } as const;

/**
 * Built on the native `<dialog>` element. `showModal()` gives the focus trap,
 * Escape handling, inert background and top-layer stacking for free — all
 * things a hand-rolled portal gets subtly wrong.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    // Escape fires `cancel`; route it through onClose so React state stays the
    // single source of truth for whether the dialog is open.
    const onCancel = (event: Event) => {
      event.preventDefault();
      onClose();
    };
    dialog.addEventListener('cancel', onCancel);
    return () => dialog.removeEventListener('cancel', onCancel);
  }, [onClose]);

  // A closed dialog is NOT in the document. A native <dialog> that is merely
  // not open keeps its whole subtree in the DOM - every input, every form id -
  // so a page with a closed "create" dialog in its sidebar had a second, empty
  // "Name" and "Slug" behind the settings form, and a footer button's `form`
  // attribute could bind to the wrong one. Unmounting on close removes the
  // whole class of problem; the open transition still animates on mount.
  if (!open) return null;

  return (
    <dialog
      ref={ref}
      aria-labelledby="dialog-title"
      onClick={(event) => {
        // The backdrop is part of the dialog's own box, so a click landing on
        // the element itself (not a child) is a click outside the content.
        if (event.target === ref.current) onClose();
      }}
      className={cn(
        'w-[calc(100vw-2rem)] rounded-lg border border-line bg-panel p-0 text-ink shadow-pop',
        'backdrop:bg-black/40 backdrop:backdrop-blur-[1px] open:animate-pop-in',
        SIZES[size],
      )}
    >
      <div className="flex items-start justify-between gap-4 border-b border-line px-4 py-3">
        <div>
          <h2 id="dialog-title" className="text-sm font-semibold">
            {title}
          </h2>
          {description && <p className="mt-0.5 text-xs text-ink-muted">{description}</p>}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close dialog"
          className="-mr-1 -mt-0.5 rounded p-1 text-ink-subtle transition-colors hover:bg-raised hover:text-ink"
        >
          <svg className="h-3.5 w-3.5" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path d="m3.5 3.5 7 7m0-7-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      {children && <div className="px-4 py-4 text-sm">{children}</div>}
      {footer && (
        <div className="flex justify-end gap-2 border-t border-line bg-raised/50 px-4 py-3">
          {footer}
        </div>
      )}
    </dialog>
  );
}
