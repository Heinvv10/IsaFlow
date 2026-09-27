/**
 * R-032 re-check MEDIUM: superseding reset links retires only OLDER links.
 *
 * Forgot-password sends detached, an admin reset can run alongside it, and a
 * double click issues two links. When two issue → send → supersede runs
 * interleave, the one whose send finishes LAST supersedes last. Retiring
 * "every other live token" then kills the NEWER link too, leaving the user two
 * dead links — and lets anyone who can trigger a reset strand a victim's
 * links. Only tokens issued before the kept one may be retired. The
 * interleaving is driven step by step, so it is deterministic.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  consumePasswordResetToken, issuePasswordResetToken, supersedePasswordResetTokens,
} from '@/lib/auth/passwordResetService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const user = crypto.randomUUID();

beforeAll(async () => {
  await pool.query(`INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)`, [user, `${user}@test.local`]);
});
afterAll(async () => {
  try {
    await pool.query('DELETE FROM auth_password_reset_tokens WHERE user_id=$1::uuid', [user]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

describe('R-032 — two interleaved resets never leave the user without a live link', () => {
  it('keeps the LATER link live when the earlier run supersedes last', async () => {
    const earlier = await issuePasswordResetToken(user); // run A issues
    const later = await issuePasswordResetToken(user); //   run B issues
    await supersedePasswordResetTokens(user, later.tokenHash); //   run B's send finished first
    await supersedePasswordResetTokens(user, earlier.tokenHash); // run A's send finished last

    await expect(consumePasswordResetToken(later.token)).resolves.toEqual({ userId: user });
    await expect(consumePasswordResetToken(earlier.token)).resolves.toBeNull();
  });

  it('breaks a created_at tie consistently, so exactly one of two tied links survives', async () => {
    const a = await issuePasswordResetToken(user);
    const b = await issuePasswordResetToken(user);
    await pool.query(`UPDATE auth_password_reset_tokens SET created_at='2026-09-26T12:00:00Z'
      WHERE token_hash = ANY($1)`, [[a.tokenHash, b.tokenHash]]);
    await supersedePasswordResetTokens(user, a.tokenHash);
    await supersedePasswordResetTokens(user, b.tokenHash);
    const live = await Promise.all([consumePasswordResetToken(a.token), consumePasswordResetToken(b.token)]);
    expect(live.filter((r) => r !== null)).toHaveLength(1);
  });
});
