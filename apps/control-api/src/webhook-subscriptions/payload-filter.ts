/**
 * `payload_filter`: a JSON predicate applied to the event body AFTER the
 * event-type filter has already matched.
 *
 * ## The state of play, stated plainly
 *
 * **The data plane does not implement this yet.** `internal/router/match.go`
 * matches on event type and nothing else. A `payload_filter` stored today is
 * inert: the subscription behaves exactly as if the field were null.
 *
 * That makes this file's job unusually specific. It is not "validate some
 * JSON" - it is **write down the language, exactly, before anything is stored
 * in it**, because the Go implementation will be written against whatever rows
 * already exist. If the shape is left loose now, the data plane's author gets
 * to guess, and every guess is a subscription whose stored filter and executed
 * filter differ. That is the same class of bug as the event-type widening this
 * module exists to prevent, arriving a release later.
 *
 * So: strict shape, bounded size, no free-form escape hatch, and the semantics
 * spelled out below and repeated verbatim in HANDOFF.md.
 *
 * ## The language
 *
 * A filter is a JSON object. Its keys are either LOGICAL operators or FIELD
 * PATHS, and the object is an implicit AND over all of them.
 *
 *     { "status": "settled", "amount": { "$gte": 1000 } }
 *
 * **Field paths** are dot-separated segments of `[A-Za-z0-9_-]+`, resolved
 * against the parsed event payload. `data.amount` reads `payload.data.amount`.
 * A path that does not exist is ABSENT, which is not an error and is not null.
 *
 * **Conditions** are either a JSON scalar - shorthand for `$eq` - or an object
 * of comparison operators, ANDed together:
 *
 * | operator          | operand              | true when                        |
 * |-------------------|----------------------|----------------------------------|
 * | `$eq` / `$ne`     | scalar               | strict JSON equality (see below) |
 * | `$gt` `$gte` `$lt` `$lte` | number       | both sides are numbers           |
 * | `$in` / `$nin`    | array of scalars     | strict equality against a member  |
 * | `$exists`         | boolean              | the path is present / absent      |
 *
 * **Logical operators** are `$and` (array, non-empty), `$or` (array, non-empty)
 * and `$not` (one filter).
 *
 * ## Semantics the data plane must implement EXACTLY
 *
 * 1. **Strict typing, no coercion.** `"1000" != 1000`, `1 != true`. JSON types
 *    are compared as JSON types. A predicate that quietly coerced would match
 *    payloads the author did not intend, which is the widening direction.
 * 2. **Absent is not null.** Only `{"$exists": false}` matches an absent path.
 *    `{"$eq": null}` matches a path that is present and holds JSON `null`.
 *    Every other operator is FALSE against an absent path, including `$ne` and
 *    `$nin` - a missing field must never satisfy a negative test, or a filter
 *    tightens into a leak the moment a producer drops a field.
 * 3. **Type mismatch is false, not an error.** `{"$gte": 10}` against a string
 *    is false. The router must not fail the delivery over it.
 * 4. **Ordering comparisons are numbers only.** Both operand and value must be
 *    JSON numbers; anything else is false. No string or date ordering - "when
 *    does `"2026-01-02" > "2026-1-3"` hold" is not a question a filter language
 *    should answer implicitly.
 * 5. **Arrays and objects are not comparable.** A path holding an array or an
 *    object satisfies only `$exists`. There is no `$contains` and no implicit
 *    "matches any element": both are real features, and both should be added
 *    deliberately with their own operator rather than fall out of `$eq`.
 * 6. **The empty object is not a filter.** See `rejectPayloadFilter`.
 * 7. **FAIL CLOSED.** A stored filter the router cannot parse or evaluate must
 *    result in NO delivery for that subscription, plus a loud operator-visible
 *    error. It must never be treated as "no filter". Everything in this file is
 *    designed so that state is unreachable; rule 7 is what happens when it is
 *    reached anyway.
 */

/**
 * Every bound, in one object, because each of them is the difference between a
 * predicate and a denial-of-service against the router.
 *
 * The router evaluates the stored filter for every subscription that survived
 * event-type matching, for every event. `maxBytes` bounds what one row costs to
 * fetch and parse, `maxDepth` and `maxNodes` bound what it costs to evaluate,
 * and `maxPathSegments` bounds the walk each condition performs. Without them a
 * caller with `subscriptions.write` - a developer, the weakest role that holds
 * it - writes one row and slows the whole data plane for their project.
 */
export const PAYLOAD_FILTER_LIMITS = {
  /** Serialised size of the whole predicate. */
  maxBytes: 4_096,
  /** Nesting depth, counting the top-level object as level 1. */
  maxDepth: 5,
  /** Total conditions and logical operators, across the whole tree. */
  maxNodes: 64,
  /** Segments in one dotted field path. */
  maxPathSegments: 8,
  /** Characters in one field path. */
  maxPathLength: 200,
  /** Members of an `$in` / `$nin` list. */
  maxListValues: 50,
  /** Branches of one `$and` / `$or`. */
  maxBranches: 20,
  /** Characters in a string operand. */
  maxStringLength: 500,
} as const;

/** Operators that take a value and test one field path. */
export const COMPARISON_OPERATORS = [
  '$eq',
  '$ne',
  '$gt',
  '$gte',
  '$lt',
  '$lte',
  '$in',
  '$nin',
  '$exists',
] as const;

/** Operators that combine whole filters. */
export const LOGICAL_OPERATORS = ['$and', '$or', '$not'] as const;

export type ComparisonOperator = (typeof COMPARISON_OPERATORS)[number];

const COMPARISON = new Set<string>(COMPARISON_OPERATORS);

/** Operators whose operand must be a JSON number. */
const NUMERIC = new Set<string>(['$gt', '$gte', '$lt', '$lte']);

/** Operators whose operand must be an array of scalars. */
const LIST = new Set<string>(['$in', '$nin']);

const PATH_SEGMENT = /^[A-Za-z0-9_-]+$/;

/**
 * Keys that must never appear as a field path, even though they satisfy the
 * segment pattern.
 *
 * The stored value is data, and nothing in this service assigns from it - but
 * the consumers of this column are a Go map walk and, one day, a JavaScript
 * operator UI, and `__proto__` reaching either is a class of bug that costs
 * nothing to make unreachable at the point where the string is first accepted.
 */
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** JSON scalars. `undefined` is not one - it is not expressible in JSON. */
function isScalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

function rejectScalar(value: unknown, where: string): string | null {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    // JSON.stringify turns these into `null`, so storing one would silently
    // change the predicate between the request body and the column.
    return `${where}: NaN and Infinity are not JSON numbers`;
  }
  if (typeof value === 'string' && value.length > PAYLOAD_FILTER_LIMITS.maxStringLength) {
    return `${where}: string operand is longer than ${PAYLOAD_FILTER_LIMITS.maxStringLength} characters`;
  }
  if (!isScalar(value)) {
    return `${where}: must be a string, number, boolean or null. Objects and arrays are not comparable - see $exists`;
  }
  return null;
}

function rejectFieldPath(path: string): string | null {
  if (path.length === 0) return 'is an empty field path';
  if (path.length > PAYLOAD_FILTER_LIMITS.maxPathLength) {
    return `is longer than ${PAYLOAD_FILTER_LIMITS.maxPathLength} characters`;
  }
  const segments = path.split('.');
  if (segments.length > PAYLOAD_FILTER_LIMITS.maxPathSegments) {
    return `has ${segments.length} segments; the maximum is ${PAYLOAD_FILTER_LIMITS.maxPathSegments}`;
  }
  for (const segment of segments) {
    if (segment.length === 0) return 'has an empty segment';
    if (FORBIDDEN_SEGMENTS.has(segment)) return `may not address "${segment}"`;
    if (!PATH_SEGMENT.test(segment)) {
      return `contains "${segment}", which is not a valid path segment: use letters, digits, "_" or "-", separated by "."`;
    }
  }
  return null;
}

interface Budget {
  nodes: number;
}

function rejectCondition(value: unknown, where: string, budget: Budget): string | null {
  // Shorthand: a bare scalar is `$eq`.
  if (!isPlainObject(value)) return rejectScalar(value, where);

  const entries = Object.entries(value);
  if (entries.length === 0) {
    return `${where}: is an empty condition. Write the value directly for equality, or name an operator (${COMPARISON_OPERATORS.join(', ')})`;
  }

  for (const [operator, operand] of entries) {
    budget.nodes += 1;
    if (budget.nodes > PAYLOAD_FILTER_LIMITS.maxNodes) {
      return `has more than ${PAYLOAD_FILTER_LIMITS.maxNodes} conditions`;
    }
    if (!COMPARISON.has(operator)) {
      return `${where}.${operator}: is not a supported operator. Comparison: ${COMPARISON_OPERATORS.join(', ')}. Logical operators belong at filter level, not inside a condition`;
    }
    if (operator === '$exists') {
      if (typeof operand !== 'boolean') return `${where}.$exists: must be true or false`;
      continue;
    }
    if (NUMERIC.has(operator)) {
      if (typeof operand !== 'number' || !Number.isFinite(operand)) {
        return `${where}.${operator}: must be a number. Ordering comparisons are numeric only`;
      }
      continue;
    }
    if (LIST.has(operator)) {
      if (!Array.isArray(operand)) return `${where}.${operator}: must be an array`;
      if (operand.length === 0) {
        return `${where}.${operator}: must not be empty. An empty $in matches nothing and an empty $nin matches everything; say which you mean`;
      }
      if (operand.length > PAYLOAD_FILTER_LIMITS.maxListValues) {
        return `${where}.${operator}: has ${operand.length} values; the maximum is ${PAYLOAD_FILTER_LIMITS.maxListValues}`;
      }
      for (const [index, member] of operand.entries()) {
        const rejection = rejectScalar(member, `${where}.${operator}[${index}]`);
        if (rejection) return rejection;
      }
      continue;
    }
    // $eq / $ne
    const rejection = rejectScalar(operand, `${where}.${operator}`);
    if (rejection) return rejection;
  }
  return null;
}

function rejectFilterObject(
  value: unknown,
  where: string,
  depth: number,
  budget: Budget,
): string | null {
  if (depth > PAYLOAD_FILTER_LIMITS.maxDepth) {
    return `${where}: nested more than ${PAYLOAD_FILTER_LIMITS.maxDepth} levels deep`;
  }
  if (!isPlainObject(value)) return `${where}: must be a JSON object`;

  const entries = Object.entries(value);
  if (entries.length === 0) {
    // The widening direction, and the same argument as an empty `event_types`:
    // a predicate that constrains nothing matches every payload, so a caller
    // who saved it by accident gets everything while the row reads as filtered.
    return `${where}: is an empty object, which would match every payload. Omit payload_filter (or send null) if you do not want to filter on the body`;
  }

  for (const [key, condition] of entries) {
    budget.nodes += 1;
    if (budget.nodes > PAYLOAD_FILTER_LIMITS.maxNodes) {
      return `has more than ${PAYLOAD_FILTER_LIMITS.maxNodes} conditions`;
    }

    if (key === '$and' || key === '$or') {
      if (!Array.isArray(condition) || condition.length === 0) {
        return `${where}.${key}: must be a non-empty array of filters`;
      }
      if (condition.length > PAYLOAD_FILTER_LIMITS.maxBranches) {
        return `${where}.${key}: has ${condition.length} branches; the maximum is ${PAYLOAD_FILTER_LIMITS.maxBranches}`;
      }
      for (const [index, branch] of condition.entries()) {
        const rejection = rejectFilterObject(branch, `${where}.${key}[${index}]`, depth + 1, budget);
        if (rejection) return rejection;
      }
      continue;
    }

    if (key === '$not') {
      const rejection = rejectFilterObject(condition, `${where}.$not`, depth + 1, budget);
      if (rejection) return rejection;
      continue;
    }

    if (key.startsWith('$')) {
      return `${where}.${key}: is not a supported operator. Logical: ${LOGICAL_OPERATORS.join(', ')}. Anything else here is read as a field path, and a field path may not begin with "$"`;
    }

    const pathRejection = rejectFieldPath(key);
    if (pathRejection) return `${where}: "${key}" ${pathRejection}`;

    // No depth argument: a condition is a FLAT map of operators to scalars and
    // cannot nest, so the filter-level depth check above is the only one there
    // is anything to count.
    const rejection = rejectCondition(condition, `${where}.${key}`, budget);
    if (rejection) return rejection;
  }

  return null;
}

/**
 * Why this predicate cannot be stored, or null when it can.
 *
 * `null` and `undefined` are accepted and mean "no payload filter" - that is
 * how the field is cleared, and it is the only way to express "match every
 * payload". An empty object is refused precisely so that there is exactly one
 * way to say it.
 */
export function rejectPayloadFilter(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (!isPlainObject(value)) {
    return 'payload_filter must be a JSON object, or null for no filter';
  }

  // Measured on the serialised form, because that is what is stored, shipped to
  // the data plane and parsed on the hot path. Also catches the pathological
  // wide-and-shallow object that passes every depth check.
  let serialised: string;
  try {
    serialised = JSON.stringify(value);
  } catch {
    // A cycle, or a value with a throwing toJSON. Not reachable through the
    // JSON body parser; reachable from a direct service call.
    return 'payload_filter is not serialisable JSON';
  }
  const bytes = Buffer.byteLength(serialised, 'utf8');
  if (bytes > PAYLOAD_FILTER_LIMITS.maxBytes) {
    return `payload_filter is ${bytes} bytes; the maximum is ${PAYLOAD_FILTER_LIMITS.maxBytes}`;
  }

  const rejection = rejectFilterObject(value, 'payload_filter', 1, { nodes: 0 });
  return rejection === null ? null : rejection;
}
