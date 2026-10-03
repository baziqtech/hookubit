import { Logger as NestLogger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { assertRoutesAreGuarded } from './authz';
import { AppExceptionFilter } from './common/errors';
import { GLOBAL_PREFIX, GLOBAL_PREFIX_EXCLUDE, buildOpenApiDocument } from './common/openapi-document';
import { corsOptions } from './config/cors';
import { applyTrustProxy } from './config/trust-proxy';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  const config = app.get(ConfigService);
  const appEnv = config.get<string>('APP_ENV') ?? 'development';

  // MUST run before anything reads req.ip - the rate limiter depends on it
  // (FIX 1). An EXACT hop count, never `true`: see config/trust-proxy.ts.
  const hops = applyTrustProxy(app, config.get<number>('TRUST_PROXY_HOPS') ?? 0);
  const bootLogger = new NestLogger('Bootstrap');
  bootLogger.log(
    hops === 0
      ? 'trust proxy: 0 hops - req.ip is the socket address. Set TRUST_PROXY_HOPS to the number of reverse proxies in front of this process, or per-IP rate limiting collapses into one shared bucket behind a proxy.'
      : `trust proxy: ${hops} hop(s) - req.ip is taken from X-Forwarded-For past ${hops} trusted proxy address(es).`,
  );

  app.use(helmet());
  app.use(cookieParser(process.env.SESSION_SECRET));
  app.setGlobalPrefix(GLOBAL_PREFIX, { exclude: GLOBAL_PREFIX_EXCLUDE });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.useGlobalFilters(new AppExceptionFilter());

  // exposedHeaders matters as much as origin here: a browser drops every
  // response header that is not CORS-safelisted or on that list, silently, so
  // `Retry-After` and `x-request-id` were being set and then discarded before
  // any cross-origin client could read them. See config/cors.ts.
  app.enableCors(corsOptions(process.env.CORS_ORIGINS));

  // Never in production (FIX 4). /docs served the full route inventory, every
  // DTO shape and every validation constraint of the production control plane
  // to anyone who asked, unauthenticated - a free reconnaissance map. The
  // OpenAPI document is still generated for clients by `pnpm openapi`.
  if (appEnv !== 'production') {
    // Built by the same function `pnpm openapi` uses, so /docs and the emitted
    // file cannot disagree. See common/openapi-document.ts.
    SwaggerModule.setup('docs', app, buildOpenApiDocument(app));
  } else {
    bootLogger.log('APP_ENV=production: /docs and the OpenAPI JSON are not mounted.');
  }

  // FIX 7: a route that declares @RequirePermission or @ResolveTenantFrom
  // without the guard that reads them serves unauthenticated, and the metadata
  // looks correct in review. Fail the deploy here rather than one request at a
  // time in production.
  assertRoutesAreGuarded(app);

  // Graceful shutdown (ARCHITECTURE.md 47).
  app.enableShutdownHooks();

  const port = Number(process.env.CONTROL_API_PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
}

void bootstrap();
