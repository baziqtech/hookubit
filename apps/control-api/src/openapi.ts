/**
 * Emits the OpenAPI document to a file, without starting a server.
 *
 * # Why this exists
 *
 * `apps/dashboard`'s client is generated from this document
 * (`openapi-typescript`), and the only way to obtain it used to be scraping
 * `/docs-json` off a RUNNING control API. That is a bad dependency for a
 * generated artefact: the running process is whatever was last built, so the
 * client could be regenerated from stale code and silently disagree with the
 * source in the same checkout. Three rounds of type drift here were expensive
 * enough that the document is now the contract, and a contract you can only
 * read by starting a server is one CI cannot check.
 *
 * main.ts already claimed `pnpm openapi` did this. The script existed and
 * pointed at a file that was never written; this is that file.
 *
 * # Preview mode
 *
 * NestFactory runs in `preview: true`, which registers controllers and their
 * metadata but instantiates no providers. That is deliberate: generating a
 * schema must not need PostgreSQL, Redis or an encryption key, or it cannot run
 * in CI or on a laptop with nothing up.
 */
import { NestFactory } from '@nestjs/core';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AppModule } from './app.module';
import { GLOBAL_PREFIX, GLOBAL_PREFIX_EXCLUDE, buildOpenApiDocument } from './common/openapi-document';

async function emit(): Promise<void> {
  const app = await NestFactory.create(AppModule, { preview: true, logger: false });

  // Shared with main.ts: the prefix is part of every path in the document, and
  // the builder is the same function /docs uses, so the two cannot drift.
  app.setGlobalPrefix(GLOBAL_PREFIX, { exclude: GLOBAL_PREFIX_EXCLUDE });

  const document = buildOpenApiDocument(app);

  const out = resolve(process.argv[2] ?? 'openapi.json');
  writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`);

  const paths = Object.keys(document.paths ?? {}).length;
  process.stdout.write(`wrote ${paths} paths to ${out}\n`);

  // A document with no paths means preview mode registered nothing; emitting it
  // would overwrite a good client with an empty one.
  if (paths === 0) {
    process.stderr.write('refusing an empty document: no routes were registered\n');
    process.exitCode = 1;
    return;
  }

  await app.close();
}

emit().catch((err: unknown) => {
  process.stderr.write(`${String(err)}\n`);
  process.exitCode = 1;
});
