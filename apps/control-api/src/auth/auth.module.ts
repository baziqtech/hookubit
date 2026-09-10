import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PrismaModule } from '../infrastructure/prisma/prisma.module';
import { MAIL_TRANSPORT, MailTransport, NotificationsModule, SmtpMailer, selectMailer } from '../notifications';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthMailer, DevelopmentAuthMailer, MAILER_PORT } from './mailer.port';
import { PasswordService } from './password.service';
import { SessionGuard } from './session.guard';
import { SessionService } from './session.service';
import { TokenService } from './token.service';

/**
 * Session verification is exported so other modules can guard their routes
 * without importing auth internals.
 *
 * `MAILER_PORT` is chosen at boot by `selectMailer`: the SMTP transport when
 * `SMTP_URL` is set, in every environment; the logging stub otherwise, and
 * only in development/test. `NotificationsModule` supplies the transport
 * (`null` when unset) - the port itself is bound here because `AuthService`
 * is its only consumer and nothing else may reach it.
 */
@Module({
  imports: [
    // Explicit since PrismaModule stopped being @Global.
    PrismaModule,
    NotificationsModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    TokenService,
    SessionService,
    SessionGuard,
    {
      provide: MAILER_PORT,
      inject: [ConfigService, MAIL_TRANSPORT],
      useFactory: (config: ConfigService, transport: MailTransport | null): AuthMailer =>
        selectMailer<AuthMailer>(config, transport, {
          smtp: (smtp, context) => new SmtpMailer(smtp, context),
          stub: () => new DevelopmentAuthMailer(config),
        }),
    },
  ],
  exports: [SessionService, SessionGuard, PasswordService, TokenService],
})
export class AuthModule {}
