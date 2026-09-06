import { Injectable } from '@nestjs/common';
import { Prisma, UserToken, UserTokenType } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { newId } from '../common/ids';
import { PrismaService } from '../infrastructure/prisma/prisma.service';

export interface IssuedToken {
  /** Shown to the user exactly once, by email. Never persisted, never logged. */
  raw: string;
  record: UserToken;
}

/** Default lifetimes, in milliseconds. */
export const TOKEN_TTL_MS: Record<UserTokenType, number> = {
  email_verification: 24 * 60 * 60 * 1000,
  password_reset: 60 * 60 * 1000,
  invitation: 7 * 24 * 60 * 60 * 1000,
};

/**
 * Single-use, hashed, expiring tokens (`user_tokens`).
 *
 * Only the SHA-256 of the token is stored, so a database leak does not hand an
 * attacker working password-reset links. Consumption is a conditional UPDATE,
 * not read-then-write: two concurrent requests presenting the same token race
 * inside PostgreSQL and exactly one wins.
 */
@Injectable()
export class TokenService {
  constructor(private readonly prisma: PrismaService) {}

  /** 256 bits of entropy, URL-safe. */
  static generateRaw(): string {
    return randomBytes(32).toString('base64url');
  }

  static hashToken(raw: string): string {
    return createHash('sha256').update(raw, 'utf8').digest('hex');
  }

  async issue(params: {
    type: UserTokenType;
    email: string;
    userId?: string | null;
    metadata?: Prisma.InputJsonValue;
    ttlMs?: number;
  }): Promise<IssuedToken> {
    const raw = TokenService.generateRaw();
    const ttl = params.ttlMs ?? TOKEN_TTL_MS[params.type];

    const record = await this.prisma.userToken.create({
      data: {
        id: newId('token'),
        userId: params.userId ?? null,
        email: params.email.toLowerCase(),
        type: params.type,
        tokenHash: TokenService.hashToken(raw),
        metadata: params.metadata ?? undefined,
        expiresAt: new Date(Date.now() + ttl),
      },
    });

    return { raw, record };
  }

  /**
   * Atomically consume a token. Returns the row only if it existed, matched the
   * expected type, was unconsumed and had not expired. Any other outcome
   * returns null - callers must not distinguish "wrong", "used" and "expired"
   * to the client.
   */
  async consume(raw: string, type: UserTokenType): Promise<UserToken | null> {
    const tokenHash = TokenService.hashToken(raw);
    const now = new Date();

    const claimed = await this.prisma.userToken.updateMany({
      where: { tokenHash, type, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });
    if (claimed.count !== 1) return null;

    return this.prisma.userToken.findUnique({ where: { tokenHash } });
  }

  /**
   * Invalidate every outstanding token of a type for an address - used after a
   * successful password reset so older reset links stop working.
   */
  async revokeOutstanding(email: string, type: UserTokenType): Promise<number> {
    const result = await this.prisma.userToken.updateMany({
      where: { email: email.toLowerCase(), type, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    return result.count;
  }
}
