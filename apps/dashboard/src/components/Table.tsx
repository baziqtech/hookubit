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
 * Dense data table. Real `<table>` semantics — the operator surface is read
 * with a screen reader and copied into support threads, both of which a div
 * grid breaks.
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

  return (
    <div className={cn('w-full overflow-x-auto scrollbar-thin', className)}>
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
  );
}
