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
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AppModule } from './app.module';
import { attachErrorResponses } from './common/openapi-errors';

async function emit(): Promise<void> {
  const app = await NestFactory.create(AppModule, { preview: true, logger: false });

  // MUST match main.ts. The prefix is part of every path in the document, so a
  // divergence here regenerates a client that calls the wrong URLs.
  app.setGlobalPrefix('v1', { exclude: ['health/live', 'health/ready'] });

  const config = new DocumentBuilder()
    .setTitle('Webhook Platform Control API')
    .setDescription('Control plane for the webhook delivery platform.')
    .setVersion('1.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer' }, 'apiKey')
    .addCookieAuth('session')
    .build();

  const document = attachErrorResponses(SwaggerModule.createDocument(app, config));

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
