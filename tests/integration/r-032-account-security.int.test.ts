/**
 * R-032 (f): a "Login as" session cannot change the target's own credentials
 * or recovery. Change email (with a password reset to the new address) would
 * take the account over; change password, adding / confirming / removing an
 * MFA factor, and the recovery contact on the profile are the same class.
 * Each answers 403 IMPERSONATION_FORBIDDEN with the users row unchanged and NO
 * GoTrue call made (every GoTrue call is faked and recorded). Logging out of a
 * Login-as session ends that session only — never the target's own sessions
 * (GoTrue /logout scope=local, not the global default). The target's own
 * session is not refused.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { NextApiHandler } from 'next';
import changeEmail from '../../pages/api/auth/change-email';
import changePassword from '../../pages/api/auth/change-password';
import twoFaEnroll from '../../pages/api/auth/2fa-enroll';
import twoFaConfirm from '../../pages/api/auth/2fa-confirm';
import twoFaDisable from '../../pages/api/auth/2fa-disable';
import profile from '../../pages/api/auth/profile';
import logout from '../../pages/api/auth/logout';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { loginAsFixture, reasonOf, type Call, type Jar } from './r-032-login-as.helpers';
import { signSession } from './r-032-fake-gotrue.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const fx = loginAsFixture(pool, 'R032 account');

beforeAll(() => fx.setUp());
afterAll(async () => {
  try {
    await pool.query(`DELETE FROM rate_limit_counters WHERE key LIKE '2fa:%:r032-factor' OR key LIKE 'change-%'`);
    await fx.tearDown();
  } finally { await pool.end(); }
});

const account = async () => (await pool.query(
  'SELECT email, first_name, last_name, phone, mobile FROM users WHERE id=$1', [fx.target])).rows[0];

type Case = { name: string; handler: NextApiHandler; call: Call };
const CASES: Case[] = [
  { name: 'change email', handler: changeEmail,
    call: { body: { newEmail: 'taken-over@r032.example', currentPassword: 'irrelevant-password' } } },
  { name: 'change password', handler: changePassword,
    call: { body: { currentPassword: 'irrelevant-password', newPassword: 'a-new-password-r032' } } },
  { name: 'MFA factor enrol', handler: twoFaEnroll, call: { body: {} } },
  { name: 'MFA factor confirm', handler: twoFaConfirm, call: { body: { factor_id: 'r032-factor', code: '123456' } } },
  { name: 'MFA factor remove', handler: twoFaDisable, call: { body: { factor_id: 'r032-factor', code: '123456' } } },
  { name: 'profile recovery contact (phone / mobile)', handler: profile,
    call: { method: 'PUT', body: { firstName: 'Taken', lastName: 'Over', phone: '+27820000000', mobile: '+27820000001' } } },
];

describe('R-032 (f) — a Login-as session changes none of the target\'s credentials', () => {
  let loginAs: Jar;
  beforeAll(async () => { loginAs = await fx.loginAsTarget(); });

  it.each(CASES)('refuses $name with 403, the account unchanged and no GoTrue call', async ({ handler, call }) => {
    const before = await account();
    const callsBefore = fx.gotrueCalls.length;
    const result = await fx.call(handler, loginAs, call);
    expect(result.state.statusCode, JSON.stringify(result.state.body)).toBe(403);
    expect(reasonOf(result)).toBe('IMPERSONATION_FORBIDDEN');
    expect(await account()).toEqual(before);
    expect(fx.gotrueCalls.slice(callsBefore)).toEqual([]);
  });

  it('refuses a cookie token with no session id — these routes accept only GoTrue sessions (fails closed)', async () => {
    const noSession = { 'sb-access-token': await signSession(fx.target, undefined, 'aal2'), active_company_id: fx.company };
    const callsBefore = fx.gotrueCalls.length;
    const result = await fx.call(changePassword, noSession, CASES[1]!.call);
    expect(result.state.statusCode, JSON.stringify(result.state.body)).toBe(403);
    expect(reasonOf(result)).toBe('IMPERSONATION_FORBIDDEN');
    expect(fx.gotrueCalls.slice(callsBefore)).toEqual([]);
  });

  it('logs a Login-as session out of itself only — never all of the target\'s sessions', async () => {
    const jar = await fx.loginAsTarget();
    const callsBefore = fx.gotrueCalls.length;
    const result = await fx.call(logout, jar, { body: {} });
    expect(result.state.statusCode).toBe(200);
    expect(fx.gotrueCalls.slice(callsBefore)).toEqual(['POST /logout?scope=local']);
  });

  it.each(CASES)('does not refuse $name on the target\'s own session', async ({ handler, call }) => {
    const result = await fx.call(handler, await fx.ownSession(), call);
    expect(reasonOf(result), JSON.stringify(result.state.body)).not.toBe('IMPERSONATION_FORBIDDEN');
  });

  it('still signs the target\'s own session out globally', async () => {
    const callsBefore = fx.gotrueCalls.length;
    const result = await fx.call(logout, await fx.ownSession(), { body: {} });
    expect(result.state.statusCode).toBe(200);
    expect(fx.gotrueCalls.slice(callsBefore)).toEqual(['POST /logout?scope=global']);
  });
});
