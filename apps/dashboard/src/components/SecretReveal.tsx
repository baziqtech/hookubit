import { useState } from 'react';
import { Button } from './Button';
import { cn } from '../lib/cn';

export interface SecretRevealProps {
  /** The plaintext. Held in component state by the caller and never cached. */
  value: string;
  label: string;
  className?: string;
}

/**
 * A credential shown EXACTLY ONCE.
 *
 * The API stores only a hash, so nothing — not the API, not the database, not
 * an operator with psql — can reproduce this value after the response that
 * carried it. That makes the copy affordance part of the contract rather than a
 * convenience: a user who closes this without copying has to revoke and
 * re-issue.
 *
 * So the warning is stated before the value, in the imperative, and it does not
 * hedge. `navigator.clipboard` is not available on an insecure origin, hence
 * the visible, selectable `<code>` that works without JavaScript succeeding.
 */
export function SecretReveal({ value, label, className }: SecretRevealProps) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard
      ?.writeText(value)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div
        role="alert"
        className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn"
      >
        <p className="font-semibold">Copy this now — you will not see it again.</p>
        <p className="mt-0.5 text-ink-muted">
          Only a hash is stored, so this value cannot be shown again or recovered by anyone,
          including support. If you lose it, you must revoke and re-issue.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <code
          data-testid="secret-plaintext"
          className="flex-1 select-all overflow-x-auto rounded border border-line bg-raised px-2 py-1.5 font-mono text-2xs text-ink"
        >
          {value}
        </code>
        <Button size="sm" variant="secondary" onClick={copy} aria-label={`Copy ${label}`}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  );
}
