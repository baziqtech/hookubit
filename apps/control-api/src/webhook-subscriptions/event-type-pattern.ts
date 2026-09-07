/**
 * Event-type filters: the reason this platform exists.
 *
 * Convoy's community licence turns `advanced_subscriptions` off, and when it is
 * off a subscription filtered to `["payment.settled"]` is SILENTLY REWRITTEN to
 * `["*"]`. It reads back as filtered in the UI and in the API, and it receives
 * every event in the project. That is a data-leak bug wearing a licence check's
 * clothing, and it is in the first paragraph of this repository's CLAUDE.md.
 *
 * So the rule for this file, from which everything below follows:
 *
 *   **A pattern is either honoured exactly as written, or refused at write
 *   time. It is never widened, never narrowed, and never stored as something
 *   the router will read differently from what the caller typed.**
 *
 * ## The contract is `services/data-plane/internal/router/match.go`
 *
 * `MatchesEventType` there is thirteen lines and this file must not disagree
 * with any of them. It accepts exactly three forms:
 *
 * | pattern            | matches                                              |
 * |--------------------|------------------------------------------------------|
 * | `*`                | everything                                           |
 * | `payment.*`        | every type beginning with the literal `payment.`     |
 * | `payment.settled`  | that type, byte for byte                             |
 *
 * The trailing-wildcard form is `strings.CutSuffix(pattern, ".*")` followed by
 * `strings.HasPrefix(eventType, prefix + ".")`. The dot is re-attached, which
 * is what makes `payment.*` NOT match `payments.settled` and NOT match the bare
 * `payment`. `matchesEventType` below is that algorithm transliterated, and
 * `event-type-pattern.spec.ts` pins the whole table.
 *
 * ## Why this validator is deliberately STRICTER than the Go matcher
 *
 * Two patterns are legal Go and refused here:
 *
 * - `.*` — `CutSuffix` leaves an empty prefix, so it matches anything starting
 *   with a literal dot. No event type in this platform begins with a dot, so
 *   the pattern is either a typo or an attempt to smuggle something past a
 *   reader. Refusing is fail-CLOSED (fewer events match), which is the safe
 *   direction; accepting a pattern nobody can read is not.
 * - `*.*`, `pay*`, `*.settled` — anything with a `*` that is not one of the two
 *   sanctioned shapes. `pay*` in particular is the dangerous one: Go falls
 *   through to exact equality, so it matches the literal type `pay*` and
 *   therefore nothing, forever, silently. A user who wrote it meant a prefix.
 *   Refusing tells them; storing it gives them a subscription that reads as
 *   filtered and delivers nothing.
 *
 * Being stricter is always safe: every pattern this file accepts is matched by
 * the router identically. Being LOOSER would not be, which is why nothing here
 * ever rewrites a pattern - `normalise` does not exist in this file on purpose.
 */

/**
 * The whole-wildcard pattern. Named because "is this string `*`?" appears in
 * three places and one of them being `'＊'` one day is not a hypothetical.
 */
export const WILDCARD_ALL = '*';

/** The suffix that makes a pattern a prefix filter. */
export const WILDCARD_SUFFIX = '.*';

/**
 * A single event type or pattern is at most this long.
 *
 * `event_types` is a `text[]` and is read on the hot path of every fan-out, for
 * every subscription in the project. There is no legitimate 4KB event type, and
 * an unbounded one is a cheap way to make the router's per-event work quadratic
 * in a value the caller controls.
 */
export const MAX_EVENT_TYPE_LENGTH = 255;

/**
 * How many patterns one subscription may carry.
 *
 * `MatchesEventType` is a linear scan per subscription per event, so this
 * multiplies with `MAX_SUBSCRIPTIONS_PER_PROJECT` into the router's per-event
 * cost. A hundred is far past any real topology - a subscription that needs
 * more than that wants a prefix filter.
 */
export const MAX_EVENT_TYPES_PER_SUBSCRIPTION = 100;

/** `payment.card.captured` is three; eight is well past any real hierarchy. */
export const MAX_EVENT_TYPE_SEGMENTS = 8;

/**
 * One dot-separated segment of an event type.
 *
 * Deliberately narrow: letters, digits, `_` and `-`. It excludes `*` (so the
 * wildcard cases below are the ONLY way a `*` reaches the database), whitespace
 * (so a pattern cannot differ from the type it means by an invisible byte), and
 * `.` (segments are what dots separate).
 */
const SEGMENT = /^[A-Za-z0-9_-]+$/;

/**
 * Exactly `MatchesEventType` from `internal/router/match.go`.
 *
 * This is a MIRROR, not a second implementation with its own opinions. It
 * exists so the control plane can state, and the test suite can pin, what the
 * data plane will do with a pattern before that pattern is stored. If the Go
 * function changes, this changes in the same commit or the validator starts
 * lying about the thing it is here to guarantee.
 *
 * Note what it does NOT do: it does not read `enabled`. `Match` in the Go file
 * skips disabled subscriptions before it gets here, and duplicating that
 * decision in two places is how the two drift.
 */
export function matchesEventType(patterns: readonly string[], eventType: string): boolean {
  for (const pattern of patterns) {
    if (pattern === WILDCARD_ALL) return true;
    if (pattern.endsWith(WILDCARD_SUFFIX)) {
      // strings.CutSuffix, then HasPrefix(eventType, prefix + "."). The dot is
      // re-attached deliberately: it is the whole reason `payment.*` does not
      // match `payments.settled`.
      const prefix = pattern.slice(0, -WILDCARD_SUFFIX.length);
      if (eventType.startsWith(`${prefix}.`)) return true;
      continue;
    }
    if (pattern === eventType) return true;
  }
  return false;
}

/** Human-readable reason a value cannot be stored, or null when it can. */
function rejectDottedName(value: string, what: string): string | null {
  const segments = value.split('.');
  if (segments.length > MAX_EVENT_TYPE_SEGMENTS) {
    return `${what} has ${segments.length} dot-separated segments; the maximum is ${MAX_EVENT_TYPE_SEGMENTS}`;
  }
  for (const segment of segments) {
    if (segment.length === 0) {
      return `${what} has an empty segment - ".." and a leading or trailing "." are not event types`;
    }
    if (!SEGMENT.test(segment)) {
      return `${what} contains "${segment}", which is not a valid segment: use letters, digits, "_" or "-", separated by "."`;
    }
  }
  return null;
}

/**
 * Why this ONE pattern cannot be stored, or null when it can.
 *
 * Every branch that returns a string is a branch where the alternative would be
 * to store something the router reads differently from the caller's intent.
 */
export function rejectEventTypePattern(value: unknown): string | null {
  if (typeof value !== 'string') return 'must be a string';
  if (value.length === 0) return 'is empty';
  if (value.length > MAX_EVENT_TYPE_LENGTH) {
    return `is ${value.length} characters; the maximum is ${MAX_EVENT_TYPE_LENGTH}`;
  }
  if (value !== value.trim()) {
    // The router compares bytes. A trailing space makes "payment.settled " a
    // type that will never be published, and it is invisible in every UI.
    return 'has leading or trailing whitespace; the router compares event types byte for byte';
  }

  if (value === WILDCARD_ALL) return null;

  if (value.endsWith(WILDCARD_SUFFIX)) {
    const prefix = value.slice(0, -WILDCARD_SUFFIX.length);
    if (prefix.length === 0) {
      return 'is ".*", which would match only event types beginning with a literal "."; write "*" if you mean everything';
    }
    if (prefix.includes(WILDCARD_ALL)) {
      return `has a "*" inside the prefix "${prefix}"; the only wildcards are "*" on its own and a single trailing ".*"`;
    }
    return rejectDottedName(prefix, `the prefix "${prefix}" before ".*"`);
  }

  if (value.includes(WILDCARD_ALL)) {
    // The silent-nothing case. Go falls through to exact equality here, so this
    // would be stored as a subscription that matches the literal string and
    // therefore never fires.
    return `contains "*" but is not a wildcard pattern; the only forms are "*" (everything) and "prefix.*" (a trailing wildcard). "${value}" would be matched as an exact event type and would never fire`;
  }

  return rejectDottedName(value, `"${value}"`);
}

/**
 * Why this LIST cannot be stored, or null when it can.
 *
 * The list-level rules are as important as the per-pattern ones:
 *
 * **Empty is refused.** `Match()` fails closed on an empty list - it matches
 * nothing - and the column default is `["*"]`, which matches everything. A
 * caller who saves `[]` therefore either meant "everything" (and would silently
 * receive nothing) or meant "nothing" (which `enabled: false` already says,
 * reversibly and legibly). Both readings are defensible, which is exactly why
 * guessing is not: coercing to `["*"]` would be Convoy's bug re-created by our
 * own hand, and storing `[]` is its mirror image - a subscription that reads as
 * configured and delivers nothing, discovered weeks later. So it is a 400 that
 * names both alternatives.
 *
 * **`"*"` may not be combined with anything else.** `["*", "payment.settled"]`
 * matches every event in the project, while the list reads as a filter with a
 * named type in it. That gap between what the row says and what it does is the
 * precise shape of the bug this module exists to prevent, and it does not stop
 * being that shape because the caller typed it themselves.
 *
 * **Duplicates are refused rather than de-duplicated.** Silently returning a
 * different array from the one that was sent is a small lie, and this file does
 * not tell small lies about filters.
 */
export function rejectEventTypes(value: unknown): string | null {
  if (!Array.isArray(value)) return 'event_types must be an array of strings';
  if (value.length === 0) {
    return 'event_types must not be empty: an empty filter matches NO events, so it is refused rather than stored or widened. Use ["*"] to receive every event type, list the types you want, or set enabled=false to stop deliveries without changing the filter';
  }
  if (value.length > MAX_EVENT_TYPES_PER_SUBSCRIPTION) {
    return `event_types has ${value.length} entries; the maximum is ${MAX_EVENT_TYPES_PER_SUBSCRIPTION}`;
  }

  const seen = new Set<string>();
  for (const [index, pattern] of value.entries()) {
    const rejection = rejectEventTypePattern(pattern);
    if (rejection) return `event_types[${index}] ${rejection}`;
    const key = pattern as string;
    if (seen.has(key)) return `event_types[${index}] repeats "${key}"`;
    seen.add(key);
  }

  if (seen.has(WILDCARD_ALL) && seen.size > 1) {
    return 'event_types contains "*" alongside other patterns. "*" already matches every event, so the subscription would read as filtered and receive everything - which is the exact failure this platform was built to avoid. Send ["*"] on its own, or drop it and list the types you want';
  }

  return null;
}
