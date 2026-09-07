import { RequestMethod } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { MetadataScanner } from '@nestjs/core';
import { AuditLogsController } from './audit-logs.controller';
import { AuditLogsService } from './audit-logs.service';

/**
 * `audit_logs` is append-only, and this suite is what keeps that a property of
 * the code rather than a claim in a docblock.
 *
 * Rows are written by `AuditService.recordFor` from inside the transaction of
 * the operation they record. A create route here would let a caller file a row
 * for something that never happened; an update or delete route would let one
 * remove the record of something that did. Either turns the table from evidence
 * into an assertion, and the damage is invisible afterwards - that is the point
 * of the table.
 *
 * The HTTP suite proves a POST/PATCH/DELETE is not ROUTED. This one reads the
 * decorator metadata directly, so a handler added with a non-GET verb fails
 * here even if nobody thinks to send that request. **If something in the log is
 * wrong, the correction is a new row.**
 */
describe('the audit module cannot mutate an audit row', () => {
  const handlers = (): Array<{ name: string; method: number; path: unknown }> => {
    const prototype = AuditLogsController.prototype as unknown as Record<string, unknown>;
    return new MetadataScanner()
      .getAllMethodNames(AuditLogsController.prototype as object)
      .map((name) => ({
        name,
        method: Reflect.getMetadata(METHOD_METADATA, prototype[name] as object) as number,
        path: Reflect.getMetadata(PATH_METADATA, prototype[name] as object),
      }));
  };

  it('declares only GET handlers', () => {
    const routes = handlers();
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) {
      expect({ handler: route.name, method: RequestMethod[route.method] }).toEqual({
        handler: route.name,
        method: 'GET',
      });
    }
  });

  it('has exactly the two read routes and no others', () => {
    expect(handlers().map((route) => `${RequestMethod[route.method]} ${String(route.path)}`).sort())
      .toEqual(['GET /', 'GET :auditLogId']);
  });

  it('exposes no service method that could write, alter or remove a row', () => {
    const surface = Object.getOwnPropertyNames(AuditLogsService.prototype).filter(
      (name) => name !== 'constructor' && !name.startsWith('_'),
    );
    // `filter` and `instant` are private statics and so are not on the
    // prototype; anything that appears here is reachable from a controller.
    expect(surface.sort()).toEqual(['get', 'list']);
  });

  it('never calls a mutating repository operation in its source', () => {
    // The belt to the reflection braces: `scope.auditLogs` exposes `create`,
    // `updateMany` and `deleteMany` like every other scoped repository, so
    // read-only here is a discipline rather than a type-level guarantee. This
    // notices the day someone reaches for one.
    const source = readFileSync(join(__dirname, 'audit-logs.service.ts'), 'utf8');
    for (const forbidden of [
      '.create(',
      '.createMany(',
      '.updateMany(',
      '.updateById(',
      '.deleteMany(',
      '.deleteById(',
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
