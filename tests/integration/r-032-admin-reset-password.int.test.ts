/**
 * R-032 M2 against Postgres: the admin "Reset password" route (real withAdmin,
 * real passwordResetService) emails a link carrying OUR token, the response
 * carries no link, and the token opens the reset exactly once. sendEmail is
 * mocked — no real email leaves the test.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

const sendEmail = vi.hoisted(() => vi.fn(async (_opts: { to: string; html: string }) => ({ success: true })));
vi.mock('@/modules/accounting/services/core/emailService', () => ({ sendEmail }));

import resetPassword from '../../pages/api/admin/users/[id]/reset-password';
import { consumePasswordResetToken } from '@/lib/auth/passwordResetService';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { signSession } from './r-032-fake-gotrue.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const platformAdmin = crypto.randomUUID();
const target = crypto.randomUUID();
const targetEmail = `${target}@test.local`;

beforeAll(async () => {
  vi.stubEnv('ENCRYPTION_KEY', 'disposable-r032-stash-encryption-key-over-32-characters');
  await pool.query(`INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'super_admin',true),($3,$4,'admin',true)`,
    [platformAdmin, `${platformAdmin}@test.local`, target, targetEmail]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM auth_password_reset_tokens WHERE user_id=$1::uuid', [target]);
    await pool.query('DELETE FROM admin_audit_log WHERE admin_user_id=$1', [platformAdmin]);
    await pool.query('DELETE FROM users WHERE id=ANY($1::text[])', [[platformAdmin, target]]);
    await pool.query("DELETE FROM rate_limit_counters WHERE key='admin:127.0.0.79'");
  } finally {
    await pool.end();
    vi.unstubAllEnvs();
  }
});

describe('R-032 M2 — admin password reset through the real route', () => {
  it('emails our single-use token, returns no link, and audits the reset', async () => {
    const jar = { 'sb-access-token': await signSession(platformAdmin, crypto.randomUUID(), 'aal2') };
    const result = response();
    await resetPassword(request(jar, 'POST', target), result.res);

    expect(result.state.statusCode, JSON.stringify(result.state.body)).toBe(200);
    expect(JSON.stringify(result.state.body)).not.toMatch(/link|token|verify|recovery/i);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const sent = sendEmail.mock.calls[0]![0];
    expect(sent.to).toBe(targetEmail);
    const token = /\/reset-password#token=([0-9a-f]{64})/.exec(sent.html)?.[1];
    expect(token, sent.html).toBeDefined();

    const stored = await pool.query('SELECT token_hash FROM auth_password_reset_tokens WHERE user_id=$1::uuid', [target]);
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0].token_hash).not.toBe(token); // only the hash is kept

    await expect(consumePasswordResetToken(token!)).resolves.toEqual({ userId: target });
    await expect(consumePasswordResetToken(token!)).resolves.toBeNull();

    const audit = await pool.query(`SELECT action FROM admin_audit_log WHERE admin_user_id=$1 AND target_id=$2`,
      [platformAdmin, target]);
    expect(audit.rows.map((r: { action: string }) => r.action)).toEqual(['user.reset_password']);
  });
});
