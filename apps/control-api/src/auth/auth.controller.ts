import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle, ThrottleGuard } from '../common/throttle.guard';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Request, Response } from 'express';
import { AuthService, RequestContext } from './auth.service';
import {
  AcknowledgedDto,
  AuthUserDto,
  ForgotPasswordDto,
  LoginDto,
  RegisterDto,
  ResetPasswordDto,
  SessionResponseDto,
  VerifyEmailDto,
} from './dto';
import { CurrentUser, SessionGuard, readSessionCookie } from './session.guard';
import { SessionUser } from './session.service';

/**
 * Thin by design: parse, delegate, shape the response. Every decision lives in
 * AuthService. `passthrough: true` lets the service set the session cookie on
 * the Express response while Nest still serialises the returned body.
 */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

@ApiTags('auth')
@Controller('auth')
// Every unauthenticated credential-handling route is rate limited. Without this
// login and forgot-password are an open brute-force and mail-bombing surface.
@UseGuards(ThrottleGuard)
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  private static context(req: Request): RequestContext {
    return {
      ipAddress: req.ip,
      userAgent: req.get('user-agent') ?? undefined,
    };
  }

  @Post('register')
  @Throttle({ name: 'auth.register', limit: 5, windowMs: HOUR, byBodyField: 'email' })
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Create an account and its organization',
    description:
      'Refused with `forbidden` unless ALLOW_OPEN_REGISTRATION=true. Otherwise always 202, ' +
      'whether or not the address is already registered - a 201/409 split let an attacker ' +
      'enumerate accounts. No session cookie is set: the user verifies the address from the ' +
      'email and then logs in. A taken address gets a "someone tried to register" notice instead.',
  })
  @ApiOkResponse({ type: AcknowledgedDto })
  async register(@Body() dto: RegisterDto, @Req() req: Request): Promise<AcknowledgedDto> {
    await this.auth.register(dto, AuthController.context(req));
    return { status: 'accepted' };
  }

  @Post('login')
  @Throttle({ name: 'auth.login', limit: 10, windowMs: 15 * MINUTE, byBodyField: 'email' })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Exchange credentials for a session cookie',
    description:
      'Returns `unauthenticated` for unknown, disabled and wrong-password alike. A correct ' +
      'password on an account whose address was never confirmed returns `email_not_verified` ' +
      'instead - only reachable once the password is already known, so it enumerates nothing.',
  })
  @ApiOkResponse({ type: SessionResponseDto })
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionResponseDto> {
    const user = await this.auth.login(dto, res, AuthController.context(req));
    return { user };
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiCookieAuth('session')
  @ApiOperation({ summary: 'Clear the session cookie', description: 'Idempotent.' })
  @ApiOkResponse({ type: AcknowledgedDto })
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AcknowledgedDto> {
    await this.auth.logout(res, readSessionCookie(req), AuthController.context(req));
    return { status: 'ok' };
  }

  @Post('verify-email')
  // Counted per address but never refused on it (FIX 1b): the token is 256 bits
  // and single-use, so an IP limit here only denies service to the users of a
  // shared address while stopping no realistic attack.
  @Throttle({ name: 'auth.verify', limit: 20, windowMs: HOUR, enforcePerIp: false })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Consume a single-use email verification token' })
  @ApiOkResponse({ type: SessionResponseDto })
  async verifyEmail(@Body() dto: VerifyEmailDto): Promise<SessionResponseDto> {
    return { user: await this.auth.verifyEmail(dto) };
  }

  @Post('forgot-password')
  @Throttle({ name: 'auth.forgot', limit: 5, windowMs: HOUR, byBodyField: 'email' })
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Request a password reset link',
    description: 'Always 202, whether or not the address is registered.',
  })
  @ApiOkResponse({ type: AcknowledgedDto })
  async forgotPassword(@Body() dto: ForgotPasswordDto): Promise<AcknowledgedDto> {
    await this.auth.forgotPassword(dto.email);
    return { status: 'accepted' };
  }

  @Post('reset-password')
  // Counted, not enforced, per address (FIX 1b) - see verify-email above. The
  // rate that matters for password reset is the mail-sending one, and that is
  // enforced per account on forgot-password.
  @Throttle({ name: 'auth.reset', limit: 10, windowMs: HOUR, enforcePerIp: false })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Consume a single-use reset token and set a new password',
    description: 'Clears any existing session; the user must log in again.',
  })
  @ApiOkResponse({ type: AcknowledgedDto })
  async resetPassword(
    @Body() dto: ResetPasswordDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AcknowledgedDto> {
    await this.auth.resetPassword(dto, res, AuthController.context(req));
    return { status: 'ok' };
  }

  @Get('session')
  @UseGuards(SessionGuard)
  @ApiCookieAuth('session')
  @ApiOperation({ summary: 'Return the user behind the current session cookie' })
  @ApiOkResponse({ type: SessionResponseDto })
  async session(@CurrentUser() session: SessionUser): Promise<SessionResponseDto> {
    const user: AuthUserDto = await this.auth.currentUser(session);
    return { user };
  }
}
