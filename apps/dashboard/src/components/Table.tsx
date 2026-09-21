import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface Column<T> {
  /** Stable key, also used for the React key of the cell. */
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  /** Column width, e.g. `w-32`. Fixed layout keeps rows from reflowing on load. */
  width?: string;
  align?: 'left' | 'right';
  /** Hidden below `md`, for columns that are useful but not essential. */
  secondary?: boolean;
  /**
   * Suppress the label in the mobile card view.
   *
   * For a cell whose content already says what it is — a status badge, a row
   * of buttons — where "Status: Delivered" reads worse than "Delivered".
   */
  unlabelled?: boolean;
}

export interface TableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** Makes the row clickable. Rendered as a real link cell for keyboard access. */
  onRowClick?: (row: T) => void;
  /** Rendered inside the tbody, replacing rows entirely. */
  empty?: ReactNode;
  loading?: ReactNode;
  caption?: string;
  className?: string;
}

/**
 * Dense data table, and the same rows as cards below `md`.
 *
 * ## Why real `<table>` semantics
 *
 * The operator surface is read with a screen reader and copied into support
 * threads, both of which a div grid breaks.
 *
 * ## Why the mobile view is a SECOND rendering rather than restyled rows
 *
 * The usual trick is `display: block` on the table elements and `data-label`
 * pseudo-elements. It is less code and it destroys the table semantics that are
 * the reason this component exists — a table whose parts are display:block is
 * no longer a table to an assistive technology, so the very thing that makes
 * this readable on a desktop screen reader is thrown away to make it look right
 * on a phone.
 *
 * So: two renderings from ONE column definition. Each is `display: none` at the
 * other's width, which removes it from the accessibility tree rather than
 * merely hiding it, so nothing is announced twice.
 *
 * The first column becomes the card's heading, because in every table here it
 * is the thing the row is ABOUT — the delivery id, the endpoint name, the
 * member. `secondary` columns are dropped on a phone exactly as they are in the
 * narrow table, so one flag governs both.
 */
export function Table<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  empty,
  loading,
  caption,
  className,
}: TableProps<T>) {
  const showBody = !loading && rows.length > 0;

  const [heading, ...rest] = columns;

  return (
    <div className={cn('w-full', className)}>
      {/* Cards, on a phone. */}
      <ul className="flex flex-col gap-2 p-2 md:hidden">
        {/*
          `loading` is `<tr>`-shaped — it is rendered into the tbody below — so
          it cannot go here. The card list gets its own placeholder rather than
          emitting table rows inside a `<ul>`.
        */}
        {loading && (
          <li className="flex flex-col gap-2">
            {[0, 1, 2].map((index) => (
              <span
                key={index}
                className="h-16 w-full animate-pulse rounded-[0.625rem] border border-line bg-raised"
              />
            ))}
          </li>
        )}
        {showBody &&
          rows.map((row) => (
            <li
              key={rowKey(row)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={cn(
                'flex flex-col gap-2 rounded-[0.625rem] border border-line bg-panel p-3',
                onRowClick && 'cursor-pointer',
              )}
            >
              {heading && <div className="min-w-0">{heading.render(row)}</div>}
              {rest.length > 0 && (
                <dl className="flex flex-col gap-1.5">
                  {rest
                    .filter((column) => !column.secondary)
                    .map((column) => (
                      <div key={column.key} className="flex items-baseline justify-between gap-3">
                        {!column.unlabelled && (
                          <dt className="shrink-0 text-2xs uppercase tracking-wide text-ink-subtle">
                            {column.header}
                          </dt>
                        )}
                        <dd className={cn('min-w-0 text-right', column.unlabelled && 'w-full')}>
                          {column.render(row)}
                        </dd>
                      </div>
                    ))}
                </dl>
              )}
            </li>
          ))}
        {!loading && rows.length === 0 && empty && <li>{empty}</li>}
      </ul>

      {/* The table, from `md` up. */}
      <div className="hidden w-full overflow-x-auto scrollbar-thin md:block">
        <table className="w-full border-collapse text-sm">
          {caption && <caption className="sr-only">{caption}</caption>}
          <thead>
            <tr className="border-b border-line">
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className={cn(
                    'whitespace-nowrap px-3 py-2 text-2xs font-medium uppercase tracking-wider text-ink-subtle',
                    column.align === 'right' ? 'text-right' : 'text-left',
                    column.secondary && 'hidden md:table-cell',
                    column.width,
                  )}
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading}
            {showBody &&
              rows.map((row) => (
                <tr
                  key={rowKey(row)}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={cn(
                    'border-b border-line last:border-0 transition-colors',
                    onRowClick && 'cursor-pointer hover:bg-raised',
                  )}
                >
                  {columns.map((column) => (
                    <td
                      key={column.key}
                      className={cn(
                        'px-3 py-2 align-middle',
                        column.align === 'right' ? 'text-right tabular' : 'text-left',
                        column.secondary && 'hidden md:table-cell',
                      )}
                    >
                      {column.render(row)}
                    </td>
                  ))}
                </tr>
              ))}
            {!loading && rows.length === 0 && empty && (
              <tr>
                <td colSpan={columns.length} className="p-0">
                  {empty}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
