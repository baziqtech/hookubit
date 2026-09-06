import { Logger as NestLogger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { AppExceptionFilter } from './common/errors';
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
  app.setGlobalPrefix('v1', { exclude: ['health/live', 'health/ready'] });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.useGlobalFilters(new AppExceptionFilter());

  const origins = (process.env.CORS_ORIGINS ?? '').split(',').filter(Boolean);
  app.enableCors({ origin: origins.length ? origins : false, credentials: true });

  // Never in production (FIX 4). /docs served the full route inventory, every
  // DTO shape and every validation constraint of the production control plane
  // to anyone who asked, unauthenticated - a free reconnaissance map. The
  // OpenAPI document is still generated for clients by `pnpm openapi`.
  if (appEnv !== 'production') {
    const openapi = new DocumentBuilder()
      .setTitle('Webhook Platform Control API')
      .setDescription('Control plane for the webhook delivery platform.')
      .setVersion('1.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer' }, 'apiKey')
      .addCookieAuth('session')
      .build();
    SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, openapi));
  } else {
    bootLogger.log('APP_ENV=production: /docs and the OpenAPI JSON are not mounted.');
  }

  // Graceful shutdown (ARCHITECTURE.md 47).
  app.enableShutdownHooks();

  const port = Number(process.env.CONTROL_API_PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
}

void bootstrap();
