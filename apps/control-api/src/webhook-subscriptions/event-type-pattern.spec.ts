import {
  MAX_EVENT_TYPES_PER_SUBSCRIPTION,
  MAX_EVENT_TYPE_LENGTH,
  matchesEventType,
  rejectEventTypePattern,
  rejectEventTypes,
} from './event-type-pattern';

/**
 * The matching table, pinned.
 *
 * `matchesEventType` is a transliteration of `MatchesEventType` in
 * `services/data-plane/internal/router/match.go`, and this block is the
 * contract between the two. If the Go function changes, one of these fails and
 * the validator's claim - "we only store patterns the router honours exactly" -
 * is re-examined rather than quietly becoming false.
 *
 * Each case is written as the Go reader would state it, because that is the
 * artefact being pinned.
 */
describe('matchesEventType mirrors internal/router/match.go', () => {
  it.each([
    // "*" matches everything, including the empty string.
    [['*'], 'payment.settled', true],
    [['*'], 'anything', true],
    [['*'], '', true],

    // "payment.*" is CutSuffix(".*") then HasPrefix(prefix + ".").
    [['payment.*'], 'payment.settled', true],
    [['payment.*'], 'payment.failed', true],
    // The dot is re-attached, so a longer FIRST SEGMENT does not match. This is
    // the case the task called out by name.
    [['payment.*'], 'payments.settled', false],
    // Nor does the bare prefix: "payment" has no dot after it.
    [['payment.*'], 'payment', false],
    // Deeper types DO match - HasPrefix does not stop at the next dot.
    [['payment.*'], 'payment.card.captured', true],
    // The dot alone is enough for Go; the prefix is "payment." exactly.
    [['payment.*'], 'payment.', true],
    // Case is significant: the router compares bytes.
    [['payment.*'], 'Payment.settled', false],
    [['payment.settled'], 'payment.Settled', false],

    // Exact equality for everything else.
    [['payment.settled'], 'payment.settled', true],
    [['payment.settled'], 'payment.settled.late', false],
    [['payment.settled'], 'payment', false],

    // A multi-segment prefix behaves the same way one segment down.
    [['payment.card.*'], 'payment.card.captured', true],
    [['payment.card.*'], 'payment.cards.captured', false],
    [['payment.card.*'], 'payment.card', false],

    // A list is an OR, and the first match wins.
    [['order.created', 'payment.*'], 'payment.settled', true],
    [['order.created', 'payment.*'], 'refund.issued', false],

    // AND THE ONE THAT STARTED ALL THIS: an empty list matches NOTHING.
    // Match() fails closed. Convoy's community build would have made this
    // ["*"] and delivered everything.
    [[], 'payment.settled', false],
    [[], '*', false],
  ] as [string[], string, boolean][])(
    'patterns %j against "%s" is %s',
    (patterns, eventType, expected) => {
      expect(matchesEventType(patterns, eventType)).toBe(expected);
    },
  );

  /**
   * The property behind the table: a prefix pattern must not match a type whose
   * first segment merely STARTS WITH the prefix. Written as a property because
   * `payment`/`payments` is one instance of it and the bug is the general shape.
   */
  it('never matches a type whose segment is a superstring of the prefix', () => {
    for (const prefix of ['payment', 'order', 'a', 'user-account']) {
      for (const suffix of ['s', 'x', '_extra', '-2']) {
        expect(matchesEventType([`${prefix}.*`], `${prefix}${suffix}.created`)).toBe(false);
      }
      expect(matchesEventType([`${prefix}.*`], `${prefix}.created`)).toBe(true);
    }
  });
});

describe('rejectEventTypePattern - the three accepted forms', () => {
  it.each(['*', 'payment.*', 'payment.settled', 'payment.card.captured', 'a', 'a-b_c.d-e_f'])(
    'accepts "%s"',
    (pattern) => {
      expect(rejectEventTypePattern(pattern)).toBeNull();
    },
  );

  /**
   * THE RULE. Every one of these is refused, and the alternative to refusing is
   * storing something the router reads differently from what the caller typed.
   * Not one of them is coerced to "*".
   */
  it.each([
    // Go would treat this as an exact type and it would never fire. A caller
    // who typed it meant a prefix.
    ['pay*', 'never fire'],
    ['*.settled', 'wildcard'],
    ['*.*', 'wildcard'],
    ['pay*ment', 'wildcard'],
    ['payment.*.settled', 'wildcard'],
    // Legal Go, refused here: matches only types beginning with a literal dot.
    ['.*', 'literal'],
    // Structure.
    ['payment..settled', 'empty segment'],
    ['.payment', 'empty segment'],
    ['payment.', 'empty segment'],
    ['payment settled', 'not a valid segment'],
    ['payment/settled', 'not a valid segment'],
    ['payment:settled', 'not a valid segment'],
    // Whitespace the router would compare byte for byte and never match.
    [' payment.settled', 'whitespace'],
    ['payment.settled ', 'whitespace'],
    ['payment.settled\n', 'whitespace'],
    ['', 'empty'],
  ])('refuses "%s"', (pattern, fragment) => {
    const rejection = rejectEventTypePattern(pattern);
    expect(rejection).not.toBeNull();
    expect(rejection).toContain(fragment);
  });

  it('refuses a non-string and an over-long pattern', () => {
    expect(rejectEventTypePattern(42)).toBe('must be a string');
    expect(rejectEventTypePattern(null)).toBe('must be a string');
    expect(rejectEventTypePattern('a'.repeat(MAX_EVENT_TYPE_LENGTH + 1))).toContain(
      `maximum is ${MAX_EVENT_TYPE_LENGTH}`,
    );
  });

  /**
   * The validator is allowed to be STRICTER than the router; it is never allowed
   * to be looser. Anything it accepts must be matched by the router exactly as
   * written - which for these two forms means "matches its own literal type".
   */
  it('every accepted pattern is honoured by the mirror', () => {
    for (const pattern of ['payment.settled', 'order.created', 'a.b.c']) {
      expect(rejectEventTypePattern(pattern)).toBeNull();
      expect(matchesEventType([pattern], pattern)).toBe(true);
    }
    for (const prefix of ['payment', 'order.card']) {
      expect(rejectEventTypePattern(`${prefix}.*`)).toBeNull();
      expect(matchesEventType([`${prefix}.*`], `${prefix}.thing`)).toBe(true);
    }
  });
});

describe('rejectEventTypes - the list rules', () => {
  it('accepts a plain filtered list and a lone wildcard', () => {
    expect(rejectEventTypes(['payment.settled', 'payment.failed'])).toBeNull();
    expect(rejectEventTypes(['*'])).toBeNull();
    expect(rejectEventTypes(['payment.*', 'refund.issued'])).toBeNull();
  });

  /**
   * THE EMPTY-ARRAY DECISION, pinned.
   *
   * `Match()` fails closed on `[]` (it matches nothing) while the column default
   * is `["*"]` (it matches everything). A caller who saves `[]` therefore either
   * meant "everything" - and would silently receive nothing - or meant "nothing",
   * which `enabled: false` already says legibly and reversibly.
   *
   * Both readings are defensible, which is exactly why guessing is not. So it is
   * refused, and the message names BOTH alternatives so the caller does not have
   * to guess either.
   */
  it('refuses an empty array, and says what to write instead', () => {
    const rejection = rejectEventTypes([]);
    expect(rejection).not.toBeNull();
    expect(rejection).toContain('matches NO events');
    // Every alternative is spelled out.
    expect(rejection).toContain('["*"]');
    expect(rejection).toContain('enabled=false');
  });

  it('never turns an empty array into a wildcard - the Convoy bug, asserted', () => {
    // There is no code path that produces `["*"]` from `[]`. The only way to
    // observe that is that the empty list is refused rather than transformed:
    // nothing in this module returns a value from `rejectEventTypes`, so a
    // widening would have to happen elsewhere, and there is no elsewhere.
    expect(rejectEventTypes([])).not.toBeNull();
    expect(matchesEventType([], 'payment.settled')).toBe(false);
  });

  /**
   * `["*", "payment.settled"]` receives every event in the project while
   * reading, in a list and in an API response, as a filter with a named type in
   * it. That gap between what a row says and what it does is the precise shape
   * of the bug this module exists to prevent, and it does not stop being that
   * shape because the caller typed it themselves.
   */
  it('refuses "*" alongside other patterns', () => {
    const rejection = rejectEventTypes(['*', 'payment.settled']);
    expect(rejection).toContain('read as filtered and receive everything');
    expect(rejectEventTypes(['payment.settled', '*'])).not.toBeNull();
  });

  it('refuses duplicates rather than silently de-duplicating', () => {
    expect(rejectEventTypes(['payment.settled', 'payment.settled'])).toContain('repeats');
  });

  it('names the offending index', () => {
    expect(rejectEventTypes(['payment.settled', 'pay*'])).toContain('event_types[1]');
  });

  it('refuses a non-array, including the null a PATCH can smuggle past @IsOptional', () => {
    expect(rejectEventTypes(null)).toBe('event_types must be an array of strings');
    expect(rejectEventTypes(undefined)).toBe('event_types must be an array of strings');
    expect(rejectEventTypes('payment.settled')).toBe('event_types must be an array of strings');
    expect(rejectEventTypes({ 0: '*' })).toBe('event_types must be an array of strings');
  });

  it('bounds the list', () => {
    const many = Array.from({ length: MAX_EVENT_TYPES_PER_SUBSCRIPTION + 1 }, (_, i) => `e.t${i}`);
    expect(rejectEventTypes(many)).toContain(`maximum is ${MAX_EVENT_TYPES_PER_SUBSCRIPTION}`);
    const exactly = many.slice(0, MAX_EVENT_TYPES_PER_SUBSCRIPTION);
    expect(rejectEventTypes(exactly)).toBeNull();
  });
});
