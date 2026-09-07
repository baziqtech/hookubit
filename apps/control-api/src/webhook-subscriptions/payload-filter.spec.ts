import { PAYLOAD_FILTER_LIMITS, rejectPayloadFilter } from './payload-filter';

/**
 * `payload_filter` is the half of subscription matching the Go router does not
 * implement yet, which makes these tests the specification rather than a
 * regression net. Whatever is accepted here is what the data plane will find in
 * the column, so the shape has to be nailed down BEFORE rows exist in it - the
 * alternative is the data-plane author guessing, and every guess is a
 * subscription whose stored filter and executed filter differ.
 *
 * The semantics these bounds go with are written out in `payload-filter.ts` and
 * repeated verbatim in HANDOFF.md.
 */
describe('rejectPayloadFilter - accepted shapes', () => {
  it.each([
    ['a scalar shorthand', { status: 'settled' }],
    ['several paths, implicitly ANDed', { status: 'settled', currency: 'GHS' }],
    ['a dotted path', { 'data.amount': 1000 }],
    ['explicit $eq', { status: { $eq: 'settled' } }],
    ['$ne', { status: { $ne: 'failed' } }],
    ['numeric ordering', { 'data.amount': { $gte: 1000, $lt: 100000 } }],
    ['$in', { currency: { $in: ['GHS', 'NGN'] } }],
    ['$nin', { currency: { $nin: ['USD'] } }],
    ['$exists', { 'data.refund_id': { $exists: false } }],
    ['null as a value', { 'data.parent': null }],
    ['booleans', { live: true }],
    ['$and', { $and: [{ status: 'settled' }, { 'data.amount': { $gte: 1 } }] }],
    ['$or', { $or: [{ status: 'settled' }, { status: 'refunded' }] }],
    ['$not', { $not: { status: 'failed' } }],
  ])('accepts %s', (_name, filter) => {
    expect(rejectPayloadFilter(filter)).toBeNull();
  });

  it('accepts null and undefined as "no filter"', () => {
    expect(rejectPayloadFilter(null)).toBeNull();
    expect(rejectPayloadFilter(undefined)).toBeNull();
  });
});

describe('rejectPayloadFilter - refusals', () => {
  /**
   * The same argument as an empty `event_types`, in the other direction: a
   * predicate that constrains nothing matches EVERY payload, so a caller who
   * saved it by accident receives everything while the row reads as filtered.
   * There is exactly one way to say "no body filter", and it is null.
   */
  it('refuses the empty object, because it would match every payload', () => {
    const rejection = rejectPayloadFilter({});
    expect(rejection).toContain('would match every payload');
    expect(rejection).toContain('null');
  });

  it('refuses an empty condition object', () => {
    expect(rejectPayloadFilter({ status: {} })).toContain('empty condition');
  });

  it.each([
    ['a non-object', 'settled'],
    ['an array', [{ status: 'settled' }]],
    ['a number', 7],
  ])('refuses %s at the top level', (_name, filter) => {
    expect(rejectPayloadFilter(filter)).toContain('must be a JSON object');
  });

  it('refuses an unknown operator rather than ignoring it', () => {
    // Ignoring it is the dangerous direction: the predicate would be weaker
    // than it reads, which is the widening direction again.
    expect(rejectPayloadFilter({ status: { $regex: '^set' } })).toContain('not a supported operator');
    expect(rejectPayloadFilter({ $where: 'true' })).toContain('not a supported operator');
    expect(rejectPayloadFilter({ status: { $contains: 'set' } })).toContain(
      'not a supported operator',
    );
  });

  it('refuses operands of the wrong type', () => {
    expect(rejectPayloadFilter({ amount: { $gte: '1000' } })).toContain('must be a number');
    expect(rejectPayloadFilter({ x: { $exists: 'yes' } })).toContain('must be true or false');
    expect(rejectPayloadFilter({ x: { $in: 'GHS' } })).toContain('must be an array');
    expect(rejectPayloadFilter({ x: { $eq: { nested: 1 } } })).toContain('not comparable');
    expect(rejectPayloadFilter({ x: { $eq: [1, 2] } })).toContain('not comparable');
    expect(rejectPayloadFilter({ x: [1, 2] })).toContain('not comparable');
  });

  it('refuses an empty $in or $nin, because the two mean opposite things', () => {
    expect(rejectPayloadFilter({ x: { $in: [] } })).toContain('must not be empty');
    expect(rejectPayloadFilter({ x: { $nin: [] } })).toContain('must not be empty');
  });

  it('refuses NaN and Infinity, which JSON.stringify would turn into null', () => {
    expect(rejectPayloadFilter({ x: Number.NaN })).toContain('not JSON numbers');
    expect(rejectPayloadFilter({ x: { $gte: Number.POSITIVE_INFINITY } })).toContain(
      'must be a number',
    );
  });

  it.each([
    ['an empty path', { '': 1 }, 'empty field path'],
    ['a path with an empty segment', { 'a..b': 1 }, 'empty segment'],
    ['a path with a space', { 'a b': 1 }, 'not a valid path segment'],
    ['a path with a slash', { 'a/b': 1 }, 'not a valid path segment'],
    ['a nested prototype-shaped path', { 'data.constructor': 1 }, 'may not address'],
    ['a prototype-shaped path', { prototype: 1 }, 'may not address'],
  ])('refuses %s', (_name, filter, fragment) => {
    expect(rejectPayloadFilter(filter)).toContain(fragment);
  });

  /**
   * `__proto__` satisfies the segment pattern, so it has to be refused by name.
   * Built the way `JSON.parse` builds it - an OWN enumerable property - because
   * an object literal with that key sets the prototype instead and would test
   * nothing.
   */
  it('refuses a __proto__ field path', () => {
    const filter = JSON.parse('{"__proto__": 1}') as Record<string, unknown>;
    expect(Object.keys(filter)).toEqual(['__proto__']);
    expect(rejectPayloadFilter(filter)).toContain('may not address');
  });

  it('refuses a filter-level operator inside a condition, and vice versa', () => {
    expect(rejectPayloadFilter({ status: { $and: [{ x: 1 }] } })).toContain(
      'not a supported operator',
    );
    expect(rejectPayloadFilter({ $eq: 'settled' })).toContain('not a supported operator');
  });

  it('refuses a $and/$or that is not a non-empty array', () => {
    expect(rejectPayloadFilter({ $and: [] })).toContain('non-empty array');
    expect(rejectPayloadFilter({ $or: { x: 1 } })).toContain('non-empty array');
  });
});

describe('rejectPayloadFilter - bounds', () => {
  /**
   * Every bound is a denial-of-service ceiling, not a style rule. The router
   * evaluates the stored predicate for every subscription that survived
   * event-type matching, for every event, so an unbounded predicate written once
   * by a `subscriptions.write` holder slows the whole project's data plane.
   */
  it('refuses a predicate over the byte ceiling', () => {
    const filter = { note: 'x'.repeat(PAYLOAD_FILTER_LIMITS.maxStringLength) };
    // One long string is fine; enough of them is not.
    expect(rejectPayloadFilter(filter)).toBeNull();
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 20; i += 1) wide[`f${i}`] = filter.note;
    expect(rejectPayloadFilter(wide)).toContain(`maximum is ${PAYLOAD_FILTER_LIMITS.maxBytes}`);
  });

  it('refuses a string operand over the string ceiling', () => {
    expect(
      rejectPayloadFilter({ x: 'y'.repeat(PAYLOAD_FILTER_LIMITS.maxStringLength + 1) }),
    ).toContain('string operand is longer');
  });

  it('refuses nesting past the depth ceiling', () => {
    // $not wraps a filter, so it is the cheapest way to build depth.
    let filter: Record<string, unknown> = { status: 'settled' };
    for (let i = 0; i < PAYLOAD_FILTER_LIMITS.maxDepth; i += 1) filter = { $not: filter };
    expect(rejectPayloadFilter(filter)).toContain('levels deep');
  });

  it('refuses more conditions than the node ceiling', () => {
    const many: Record<string, unknown> = {};
    for (let i = 0; i <= PAYLOAD_FILTER_LIMITS.maxNodes; i += 1) many[`f${i}`] = i;
    expect(rejectPayloadFilter(many)).toContain(`more than ${PAYLOAD_FILTER_LIMITS.maxNodes}`);
  });

  it('refuses a path with too many segments', () => {
    const path = Array.from({ length: PAYLOAD_FILTER_LIMITS.maxPathSegments + 1 }, (_, i) => `s${i}`).join('.');
    expect(rejectPayloadFilter({ [path]: 1 })).toContain(
      `maximum is ${PAYLOAD_FILTER_LIMITS.maxPathSegments}`,
    );
  });

  it('refuses an over-long $in list and too many $or branches', () => {
    const values = Array.from({ length: PAYLOAD_FILTER_LIMITS.maxListValues + 1 }, (_, i) => i);
    expect(rejectPayloadFilter({ x: { $in: values } })).toContain(
      `maximum is ${PAYLOAD_FILTER_LIMITS.maxListValues}`,
    );
    const branches = Array.from(
      { length: PAYLOAD_FILTER_LIMITS.maxBranches + 1 },
      (_, i) => ({ [`f${i}`]: i }),
    );
    expect(rejectPayloadFilter({ $or: branches })).toContain(
      `maximum is ${PAYLOAD_FILTER_LIMITS.maxBranches}`,
    );
  });
});
