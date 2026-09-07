import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ListEndpointsQueryDto } from './list-endpoints.query.dto';

/**
 * FIX 3. `@Type(() => Boolean)` on a query parameter runs `Boolean(value)`, and
 * Express hands a query parameter over as a STRING: `Boolean('false')` is true,
 * `Boolean('0')` is true, and only `''` came out false. So
 * `?include_deleted=false` - the explicit way to ask for the default - turned
 * soft-deleted endpoints ON.
 *
 * This is the first boolean query parameter in the codebase and eight modules
 * are still to be written against the same idiom, so the transform is pinned
 * here by value rather than left to be re-derived.
 */
describe('include_deleted, the first boolean query parameter', () => {
  function parse(query: Record<string, unknown>): ListEndpointsQueryDto {
    return plainToInstance(ListEndpointsQueryDto, query, {
      enableImplicitConversion: false,
    });
  }

  it.each([
    ['true', true],
    ['1', true],
    ['false', false],
    ['0', false],
    ['no', false],
    ['', undefined],
  ])('parses ?include_deleted=%s as %s', (raw, expected) => {
    expect(parse({ include_deleted: raw }).include_deleted).toBe(expected);
  });

  it('leaves an absent parameter undefined rather than defaulting it', () => {
    expect(parse({}).include_deleted).toBeUndefined();
    expect(validateSync(parse({}))).toEqual([]);
  });

  it('produces a boolean the validator accepts, for every accepted spelling', () => {
    for (const raw of ['true', '1', 'false', '0']) {
      const dto = parse({ include_deleted: raw });
      expect(typeof dto.include_deleted).toBe('boolean');
      expect(validateSync(dto)).toEqual([]);
    }
  });

  it('still accepts a real boolean, for a caller that is not a query string', () => {
    expect(parse({ include_deleted: true }).include_deleted).toBe(true);
    expect(parse({ include_deleted: false }).include_deleted).toBe(false);
  });
});
