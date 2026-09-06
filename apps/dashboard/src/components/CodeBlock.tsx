import { useMemo, useState } from 'react';
import { cn } from '../lib/cn';
import { formatBytes } from '../lib/format';

export interface CodeBlockProps {
  /** Any JSON-serialisable value, or a pre-formatted string. */
  value: unknown;
  language?: 'json' | 'http' | 'text';
  /** Caps rendered height; the block scrolls rather than pushing the page down. */
  maxHeight?: string;
  showLineNumbers?: boolean;
  className?: string;
  label?: string;
}

/**
 * JSON/payload viewer. Payloads here are real customer traffic — occasionally
 * megabytes — so the block is height-capped and scrollable, and anything past
 * `TRUNCATE_AT` is cut with the size stated rather than freezing the tab.
 */
const TRUNCATE_AT = 512 * 1024;

export function CodeBlock({
  value,
  language = 'json',
  maxHeight = '22rem',
  showLineNumbers = false,
  className,
  label,
}: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const { text, truncated, bytes } = useMemo(() => {
    const raw = typeof value === 'string' ? value : safeStringify(value);
    const size = new TextEncoder().encode(raw).length;
    return size > TRUNCATE_AT
      ? { text: raw.slice(0, TRUNCATE_AT), truncated: true, bytes: size }
      : { text: raw, truncated: false, bytes: size };
  }, [value]);

  const lines = useMemo(
    () => (showLineNumbers ? text.split('\n') : null),
    [text, showLineNumbers],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard denied (insecure context or policy). The text is selectable.
    }
  };

  return (
    <figure
      className={cn('overflow-hidden rounded-md border border-line bg-raised/60', className)}
    >
      <figcaption className="flex items-center justify-between gap-2 border-b border-line bg-panel px-2.5 py-1.5">
        <span className="text-2xs font-medium uppercase tracking-wider text-ink-subtle">
          {label ?? language}
        </span>
        <span className="flex items-center gap-2">
          <span className="text-2xs tabular text-ink-subtle">{formatBytes(bytes)}</span>
          <button
            type="button"
            onClick={copy}
            className="rounded border border-line px-1.5 py-0.5 text-2xs text-ink-muted transition-colors hover:bg-raised hover:text-ink"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </span>
      </figcaption>

      <div className="overflow-auto scrollbar-thin" style={{ maxHeight }}>
        <pre className="flex min-w-full text-xs leading-[1.6]">
          {lines && (
            <span
              aria-hidden="true"
              className="select-none border-r border-line px-2 py-2.5 text-right font-mono text-ink-subtle"
            >
              {lines.map((_, index) => (
                <span key={index} className="block tabular">
                  {index + 1}
                </span>
              ))}
            </span>
          )}
          <code className="block flex-1 whitespace-pre px-3 py-2.5 font-mono text-ink">{text}</code>
        </pre>
      </div>

      {truncated && (
        <p className="border-t border-line bg-warn-soft px-2.5 py-1.5 text-2xs text-warn">
          Truncated for display at {formatBytes(TRUNCATE_AT)} of {formatBytes(bytes)}. Copy returns
          the truncated text; use the API for the full payload.
        </p>
      )}
    </figure>
  );
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    // Circular or non-serialisable — never blow up a detail page over display.
    return String(value);
  }
}
