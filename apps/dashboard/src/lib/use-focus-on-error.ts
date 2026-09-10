import { useEffect, useRef } from 'react';

/**
 * Moves focus onto the failure the moment it appears.
 *
 * A mutation that fails inside a dialog leaves focus on a button whose label
 * has not changed, so a screen-reader user is told nothing and a sighted user
 * is looking at the wrong end of the box. `role="alert"` on the notice
 * announces the text; this puts the caret next to it as well.
 *
 * Attach the ref to a `tabIndex={-1}` wrapper around `WriteErrorNotice`.
 */
export function useFocusOnError(isError: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (isError) ref.current?.focus();
  }, [isError]);
  return ref;
}
