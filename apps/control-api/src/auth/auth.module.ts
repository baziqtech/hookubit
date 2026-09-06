import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { DevelopmentAuthMailer, MAILER_PORT } from './mailer.port';
import { PasswordService } from './password.service';
import { SessionGuard } from './session.guard';
import { SessionService } from './session.service';
import { TokenService } from './token.service';

/**
 * Session verification is exported so other modules can guard their routes
 * without importing auth internals. Swap MAILER_PORT for a real transport when
 * the notifications module lands - nothing else has to change.
 */
@Module({
  imports: [
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
    { provide: MAILER_PORT, useClass: DevelopmentAuthMailer },
  ],
  exports: [SessionService, SessionGuard, PasswordService, TokenService],
})
export class AuthModule {}
