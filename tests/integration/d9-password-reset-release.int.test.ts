/**
 * D9 round 4: releasePasswordResetToken against real Postgres.
 *
 * do-reset-password consumes the single-use link BEFORE it calls GoTrue. When
 * that call meets an outage the route hands the link back, so the user's retry
 * with the same link completes the reset. The release must not resurrect a
 * link that should stay dead: an expired one, or one a NEWER link has replaced.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  consumePasswordResetToken, issuePasswordResetToken, releasePasswordResetToken,
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

describe('D9 — handing a reset link back after an auth outage', () => {
  it('a released link can be consumed again, exactly once', async () => {
    const link = await issuePasswordResetToken(user);
    await expect(consumePasswordResetToken(link.token)).resolves.toEqual({ userId: user });
    await expect(consumePasswordResetToken(link.token)).resolves.toBeNull();
    await releasePasswordResetToken(link.token);
    await expect(consumePasswordResetToken(link.token)).resolves.toEqual({ userId: user });
    await expect(consumePasswordResetToken(link.token)).resolves.toBeNull();
    await pool.query('DELETE FROM auth_password_reset_tokens WHERE user_id=$1::uuid', [user]);
  });

  it('a link a newer one has replaced stays dead', async () => {
    const older = await issuePasswordResetToken(user);
    await expect(consumePasswordResetToken(older.token)).resolves.toEqual({ userId: user });
    const newer = await issuePasswordResetToken(user);
    await releasePasswordResetToken(older.token);
    await expect(consumePasswordResetToken(older.token)).resolves.toBeNull();
    await expect(consumePasswordResetToken(newer.token)).resolves.toEqual({ userId: user });
    await pool.query('DELETE FROM auth_password_reset_tokens WHERE user_id=$1::uuid', [user]);
  });

  it('an expired link stays consumed', async () => {
    const link = await issuePasswordResetToken(user);
    await expect(consumePasswordResetToken(link.token)).resolves.toEqual({ userId: user });
    await pool.query(`UPDATE auth_password_reset_tokens SET expires_at = now() - interval '1 minute' WHERE token_hash=$1`, [link.tokenHash]);
    await releasePasswordResetToken(link.token);
    const row = await pool.query('SELECT consumed_at FROM auth_password_reset_tokens WHERE token_hash=$1', [link.tokenHash]);
    expect(row.rows[0]?.consumed_at).not.toBeNull();
    await pool.query('DELETE FROM auth_password_reset_tokens WHERE user_id=$1::uuid', [user]);
  });
});
