/**
 * Package B review LOW (#1466): POST /api/auth/verify-email when another users row already holds
 * the signup's address. provisionTenant's users INSERT arbitrates only on id, so a row under a
 * different id holding the address (a pre-GoTrue-cutover profile, a deleted-and-recreated GoTrue
 * identity) raised 23505 out of the route as a 500: on users_email_key for the exact address and,
 * since migration 999, on users_email_lower_key for a case variant. Now both are a 409
 * EMAIL_IN_USE, nothing is provisioned, GoTrue is not asked to confirm, and the transaction rolls
 * back so the link is not spent (opening it again answers the same, never 410).
 *
 * Real route on the production migration_admin login; only GoTrue is stubbed.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getAuthPool } from '@/lib/auth/authPool';
import { getDbPool } from '@/lib/neon';
import { migrationAdminPool } from '@/lib/auth/migrationAdminPool';
import { createEmailVerificationToken, type PendingSignup } from '@/lib/auth/emailVerificationService';
import verifyEmailRoute from '../../pages/api/auth/verify-email';
import { callRoute } from './s07-users-privilege-columns.helpers';
import { gotruePath } from './mfa-impersonation-postgres.helpers';
import { fixture, newIds, setup, teardown } from './s07b-app-pool-login-role.helpers';

vi.mock('@/modules/accounting/services/core/emailService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/accounting/services/core/emailService')>()),
  sendEmail: vi.fn(async () => ({ success: true })),
}));

const ids = newIds();
const created: string[] = [];

beforeAll(() => setup(ids), 60000);
afterAll(async () => {
  await fixture.query('DELETE FROM company_users WHERE user_id = ANY($1)', [created]);
  await fixture.query('DELETE FROM auth_email_verification_tokens WHERE gotrue_user_id = ANY($1)', [created]);
  await fixture.query('DELETE FROM users WHERE id = ANY($1)', [created]);
  await teardown(ids, [getAuthPool(), getDbPool(), migrationAdminPool()]);
});

describe('verify-email: the address is held by another users row', () => {
  it.each([
    ['in another letter case (users_email_lower_key)', (e: string) => e.toUpperCase()],
    ['exactly (users_email_key)', (e: string) => e],
  ])('%s: 409 EMAIL_IN_USE, nothing provisioned, the link not spent', async (_, held) => {
    const userId = crypto.randomUUID();
    const legacy = crypto.randomUUID();
    created.push(userId, legacy);
    const email = `signup-${userId}@test.local`;
    await fixture.query('INSERT INTO users (id, email, is_active) VALUES ($1, $2, true)', [legacy, held(email)]);
    const pending: PendingSignup = { email, firstName: 'Sign', lastName: 'Up',
      companyName: `EMAILCI signup ${userId}`, phone: null, annualTurnoverCents: null, signupType: 'direct' };
    const { token } = await createEmailVerificationToken(userId, pending);
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const path = gotruePath(new URL(String(input)));
      if (path !== `/admin/users/${userId}`) throw new Error(`unexpected fetch ${String(input)}`);
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      return new Response(JSON.stringify({ id: userId, email }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    try {
      for (const attempt of [1, 2]) {
        const r = await callRoute(verifyEmailRoute, { sub: userId, method: 'POST', body: { token } });
        expect({ attempt, status: r.status }, JSON.stringify(r.body)).toEqual({ attempt, status: 409 });
        expect(r.body).toMatchObject({ success: false, error: { code: 'EMAIL_IN_USE' } });
      }
    } finally {
      vi.unstubAllGlobals();
    }
    expect(calls).toEqual([`GET /admin/users/${userId}`, `GET /admin/users/${userId}`]);
    expect((await fixture.query('SELECT 1 FROM users WHERE id = $1', [userId])).rowCount).toBe(0);
    expect((await fixture.query('SELECT 1 FROM company_users WHERE user_id = $1', [userId])).rowCount).toBe(0);
    expect((await fixture.query('SELECT 1 FROM companies WHERE name = $1', [pending.companyName])).rowCount).toBe(0);
    expect((await fixture.query('SELECT email FROM users WHERE id = $1', [legacy])).rows).toEqual([{ email: held(email) }]);
  }, 60000);
});
