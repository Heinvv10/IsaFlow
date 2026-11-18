/**
 * Breaker repros for PR #1570 (SS-a), kept as regression tests (round 1 fixed both). Each `it` states the property
 * the PR claims; a red test is a confirmed break.
 * Disposable DB only (rig -> assertDisposable). Every address is @example.invalid; the capture mailer sends nothing.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { rig } from './brkr.helpers';
import {
  captured, cleanup, doAccept, doLogin, doMe, invite, lastToken, person, putSetting, readAccess, reason, setPlatform, type R,
} from './ss-employee-portal.helpers';

vi.hoisted(() => { process.env.PORTAL_JWT_SECRET ??= 'ss-employee-portal-secret-for-tests-0123456789abcdef'; });

let a: R;
const PW = 'correct horse battery';

beforeAll(async () => {
  a = await rig('employee-portal-breaker');
  await a.setup();
  await a.pool.query("DELETE FROM rate_limit_counters WHERE key LIKE 'employee-portal-%' OR key LIKE 'send:employee-portal-invite:%'");
  await setPlatform(a, true);
  expect((await putSetting(a, true)).statusCode).toBe(200);
}, 120_000);
afterAll(async () => { await cleanup(a); });

describe('PR 1570 breaker', () => {
  it('B1: the per-address brute-force limit holds for every spelling the login lookup matches', async () => {
    const emp = await person(a, 'william@example.invalid');
    expect((await invite(a, emp)).statusCode).toBe(200);
    expect((await doAccept({}, { token: lastToken(), password: PW }, '198.18.1.1')).statusCode).toBe(200);
    // Exhaust the address's 5 attempts, each from its own IP (the IP limit is not the one under test).
    for (let i = 0; i < 5; i += 1) {
      expect((await doLogin({}, { email: 'william@example.invalid', password: `wrong-${i}` }, `203.0.113.${10 + i}`)).statusCode).toBe(401);
    }
    expect((await doLogin({}, { email: 'william@example.invalid', password: PW }, '203.0.113.40')).statusCode).toBe(429);
    // U+0130: Postgres lower() (en_US.UTF-8) folds it to 'i', so the lookup found William's login; JS toLowerCase()
    // gives 'i' + U+0307, so the rate-limit key was a different, fresh bucket. Each 'i' doubled the guesses.
    // Fixed (coordinator ruling M1): one normaliser (trim, NFKC, lowercase) keys both the bucket and the lookup, and an
    // address that is not plain ASCII after it is a plain 400, before any lookup. So no spelling signs in.
    const variants = ['wİlliam@example.invalid', 'willİam@example.invalid', 'wİllİam@example.invalid'];
    const answers: Array<[number, unknown]> = [];
    for (const [k, email] of variants.entries()) {
      const res = await doLogin({}, { email, password: PW }, `203.0.113.${50 + k}`);
      answers.push([res.statusCode, res.headers.get('set-cookie')]);
    }
    expect(answers).toEqual([[400, undefined], [400, undefined], [400, undefined]]);
    // Spellings that ARE the same ASCII address share its bucket: still locked.
    for (const email of ['  WILLIAM@example.invalid ', 'Ｗｉｌｌｉａｍ@example.invalid']) {
      expect((await doLogin({}, { email, password: PW }, '203.0.113.60')).statusCode).toBe(429);
    }
  });

  it('B2: an invitation sent to an address the employer has since corrected cannot be accepted', async () => {
    const emp = await person(a, 'typo-stranger@example.invalid');
    expect((await invite(a, emp)).statusCode).toBe(200);
    expect(captured.at(-1)!.to).toBe('typo-stranger@example.invalid');
    const strangersToken = lastToken();
    // The employer fixes the address on the employee record (PE's payroll_employees.email) and does nothing else.
    await a.pool.query('UPDATE payroll_employees SET email = $2 WHERE id = $1', [emp, 'right-person@example.invalid']);
    const jar: Record<string, string> = {};
    const acc = await doAccept(jar, { token: strangersToken, password: PW }, '198.18.1.2');
    const me = await doMe(jar);
    const view = (await readAccess(a, emp)).body.data;
    // The holder of the old address must not get the employee's portal; today they do, and keep it under the old
    // address (the login row's email never follows the employee record).
    expect({ accept: acc.statusCode, me: me.statusCode }).toEqual({ accept: 400, me: 401 });
    expect(view?.email).toBe('right-person@example.invalid');
    expect(reason(acc)).toBe('INVITE_INVALID');
  });
});
