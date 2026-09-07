import type { Paged } from '../lib/pagination';
import { pageRange } from '../lib/pagination';
import { Button } from './Button';

export interface PagerProps {
  page: Paged<unknown>;
  offset: number;
  onOffsetChange: (offset: number) => void;
  /** Rows per request, so "previous" can step back by the same amount. */
  limit: number;
  /** What is being counted, for the screen-reader label. */
  label: string;
}

/**
 * Offset pagination controls.
 *
 * This exists because the list envelopes carry `has_more`, and a list that has
 * more results MUST NOT look complete. Prev/next over offsets rather than
 * infinite scroll, deliberately: the operator surface is read to answer "have I
 * seen every key that can authenticate as us?", and a scroll position is not an
 * answer to that — a page number is, and it survives being pasted into an
 * incident channel.
 *
 * The pager renders even on a single page, showing the range. A control that
 * disappears when there is nothing more is indistinguishable from a control
 * that failed to render, and the whole point here is that "complete" is stated
 * rather than inferred.
 */
export function Pager({ page, offset, onOffsetChange, limit, label }: PagerProps) {
  const canPrevious = offset > 0;
  const next = page.nextOffset;

  return (
    <nav
      aria-label={`${label} pagination`}
      className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-3 py-2"
    >
      <p className="text-2xs text-ink-muted">
        <span className="tabular">{pageRange(offset, page)}</span>{' '}
        <span className="text-ink-subtle">{label}</span>
        {page.hasMore && (
          /*
           * Said out loud. A full page and a complete result look identical
           * otherwise, and that ambiguity is the defect the envelope exists to
           * close — so the UI states which one this is.
           */
          <span className="ml-1.5 rounded border border-warn/40 bg-warn/10 px-1.5 py-0.5 text-warn">
            more not shown
          </span>
        )}
      </p>

      <span className="flex items-center gap-1.5">
        <Button
          size="sm"
          disabled={!canPrevious}
          onClick={() => onOffsetChange(Math.max(0, offset - limit))}
        >
          Previous
        </Button>
        <Button
          size="sm"
          disabled={next === null}
          onClick={() => next !== null && onOffsetChange(next)}
        >
          Next
        </Button>
      </span>
    </nav>
  );
}
