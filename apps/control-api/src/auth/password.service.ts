import { Injectable } from '@nestjs/common';
import argon2 from 'argon2';

/**
 * Argon2id password hashing (ARCHITECTURE.md 9, 43).
 *
 * Parameters are deliberately explicit rather than left to library defaults so
 * that a dependency bump cannot silently weaken every password in the database.
 * `verify` never throws on a malformed stored hash - a corrupt row must read as
 * "wrong password", not as a 500 that tells an attacker the account exists.
 */
@Injectable()
export class PasswordService {
  /** OWASP-aligned: 19 MiB, 2 passes, 1 lane. */
  private static readonly OPTIONS = {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  } as const;

  /** Long inputs are rejected before hashing; argon2 cost is attacker-controlled otherwise. */
  static readonly MIN_LENGTH = 12;
  static readonly MAX_LENGTH = 128;

  async hash(plaintext: string): Promise<string> {
    return argon2.hash(plaintext, PasswordService.OPTIONS);
  }

  async verify(hash: string, plaintext: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plaintext);
    } catch {
      return false;
    }
  }

  /**
   * Constant-ish work for a non-existent user, so that "unknown email" and
   * "wrong password" take comparable time and cannot be distinguished.
   */
  async dummyVerify(): Promise<void> {
    await argon2.hash('invalid-password-placeholder', PasswordService.OPTIONS);
  }
}
