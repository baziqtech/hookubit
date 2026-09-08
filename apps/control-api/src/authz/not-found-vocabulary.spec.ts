import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '../common/errors';
import { DEFAULT_TENANT_SPEC, RequestContext } from './tenant-context';
import { CROSS_TENANT_MESSAGE, TenantResolver } from './tenant-resolver.service';
import { TenantScopeFactory } from './tenant-scope.factory';
import { IDS, requestWith, seedWorld, sessionUser } from './testing/fixtures';
import { FakeTenantPrisma } from './testing/tenant-prisma.fake';

/**
 * ONE 404 VOCABULARY, ENFORCED.
 *
 * Two coexisted: `ScopedRepository.notFound()` said `"<Resource> not found."`
 * and `TenantResolver` said `CROSS_TENANT_MESSAGE`, so `endpoints` and
 * `endpoint-secrets` answered in one dialect while `members` and `api-keys`
 * answered in the other. Neither was an oracle - a per-resource message was only
 * ever reached for an id inside an already-resolved tenant - but eight modules
 * are still to be written against whichever idiom their author meets first, and
 * the first person to write a message that IS specific to "exists but is not
 * yours" would not notice they had broken the invariant.
 *
 * These two tests are the fence: one over the behaviour, one over the source, so
 * a new module cannot reintroduce a second dialect without a red test.
 */

const SRC = join(__dirname, '..');

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
      continue;
    }
    // Specs are excluded deliberately: a test asserting the OLD wording is how
    // the regression would be described, not how it would be introduced.
    if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) found.push(path);
  }
  return found;
}

async function context(): Promise<{ db: FakeTenantPrisma; scopes: TenantScopeFactory; ctx: RequestContext }> {
  const db = seedWorld();
  const prisma = db.asPrisma();
  const ctx = await new TenantResolver(prisma).resolve(
    sessionUser(IDS.ownerA),
    requestWith({ orgId: IDS.orgA, projectId: IDS.projectA1 }, IDS.ownerA),
    DEFAULT_TENANT_SPEC,
  );
  return { db, scopes: new TenantScopeFactory(prisma), ctx };
}

describe('the 404 vocabulary', () => {
  it('answers every "not in this tenant" with the same string, whatever the table', async () => {
    const { scopes, ctx } = await context();
    const scope = scopes.for(ctx);

    // A different table per row, each reached by a different repository method,
    // and each id either absent or another tenant's - the two cases that must be
    // indistinguishable. Before this fix the first three said "Endpoint not
    // found.", "API key not found." and "Member not found.".
    const misses: Array<Promise<unknown>> = [
      scope.endpoints.requireById(IDS.endpointB1),
      scope.apiKeys.requireById('key_absent'),
      scope.members.requireById('mem_absent'),
      scope.projects.requireById(IDS.projectB1),
      scope.retryPolicies.requireById(IDS.retryPolicyB1),
      scope.endpoints.updateById(IDS.endpointB1, { name: 'stolen' }),
      scope.endpoints.deleteById(IDS.endpointB1),
    ];

    const messages = new Set<string>();
    for (const miss of misses) {
      const error = await miss.then(
        () => null,
        (err: unknown) => err,
      );
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('not_found');
      messages.add((error as AppError).message);
    }

    expect([...messages]).toEqual([CROSS_TENANT_MESSAGE]);
  });

  it('leaves the resource name in the errors that are NOT existence answers', async () => {
    const { scopes, ctx } = await context();

    // The alignment must not flatten everything into one string: a programming
    // error still has to say which table it was about, because unlike a 404 it
    // is not answering "does this exist for you?" and there is nothing to leak.
    await expect(
      scopes.for(ctx).apiKeys.create({ id: 'key_x', nonsense: true } as never),
    ).rejects.toMatchObject({ code: 'invalid_request', message: expect.stringContaining('API key') });
  });

  it('has no second 404 dialect anywhere in the source', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const source = readFileSync(file, 'utf8');
      // Every `not_found` AppError must take CROSS_TENANT_MESSAGE by name. A
      // string literal there is a second vocabulary, whatever it says.
      const pattern = /new AppError\(\s*'not_found'\s*,\s*([^,)\s][^,)]*)/g;
      for (const match of source.matchAll(pattern)) {
        const message = match[1].trim();
        if (message !== 'CROSS_TENANT_MESSAGE') {
          offenders.push(`${file.slice(SRC.length + 1)}: ${message}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
