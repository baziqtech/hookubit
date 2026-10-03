import { Badge, CodeBlock } from '../../components';
import { formatBytes, truncateId } from '../../lib/format';
import type { EventPayload } from '../../types/api';

/**
 * The payload, as the API actually returns it.
 *
 * `EventPayloadDto` is an ENVELOPE, not the raw body: it says where the bytes
 * came from (`inline`, `object_storage`, `unavailable`) and carries a `notice`
 * explaining the case. An event whose payload was offloaded to object storage —
 * or is simply gone — must not render as an empty code block, which is what
 * reading `payload` as the body would have produced.
 *
 * It lives here, shared, because TWO screens show these bytes: the event's
 * Payload tab and a delivery's Request tab. A second copy of this envelope
 * reading would eventually diverge, and the copy that rots is the one that
 * renders an empty box for an offloaded payload — the exact bug this comment
 * exists to prevent.
 */
export function EventPayloadView({ payload }: { payload: EventPayload }) {
  /*
   * `normalised_json` first because it pretty-prints, and `body` as the
   * authority when there is no jsonb copy. A base64 body is still shown — it is
   * the bytes, honestly labelled — rather than hidden behind "unavailable".
   */
  const body =
    payload.normalised_json ??
    (payload.encoding === 'base64' ? payload.body : (payload.body ?? null));

  return (
    <div className="flex flex-col gap-2">
      <p className="flex flex-wrap items-center gap-2 text-2xs text-ink-subtle">
        <Badge tone={payload.source === 'inline' ? 'neutral' : 'warn'}>{payload.source}</Badge>
        <span>{formatBytes(payload.size_bytes)}</span>
        <span className="font-mono">sha256:{truncateId(payload.sha256, 12)}</span>
      </p>
      {payload.notice && (
        <p className="rounded-md border border-line bg-raised px-3 py-2 text-xs leading-relaxed text-ink-muted">
          {payload.notice}
        </p>
      )}
      {body === null ? (
        <p className="rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-warn">
          The payload is not available to read here
          {payload.location ? ` — it is held at ${payload.location}.` : '.'}
        </p>
      ) : (
        <CodeBlock
          value={body}
          language={payload.encoding === 'base64' ? 'text' : undefined}
          label="payload"
          showLineNumbers
          maxHeight="34rem"
        />
      )}
    </div>
  );
}
