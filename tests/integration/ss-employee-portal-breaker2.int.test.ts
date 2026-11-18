/**
 * Breaker round 2 for PR #1570 (SS-a) at e767de4191: normaliser spellings, the same-origin guard, and an address
 * change racing an in-flight accept. Disposable DB only; @example.invalid only; capture mailer.
 */
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { rig } from './brkr.helpers';
import {
  cleanup, doAccept, doLogin, doMe, invite, lastToken, person, portal, portalRoutes, putSetting, setPlatform, type R,
} from './ss-employee-portal.helpers';
import { endPortalAccessForAddressChange } from '@/modules/accounting/services/payroll/employeePortalAddressChange';

vi.hoisted(() => { process.env.PORTAL_JWT_SECRET ??= 'ss-employee-portal-secret-for-tests-0123456789abcdef'; });

let a: R;
const PW = 'correct horse battery';
let ipn = 0;
const ip = () => `203.0.114.${(ipn += 1)}`;

beforeAll(async () => {
  a = await rig('employee-portal-breaker2');
  await a.setup();
  await a.pool.query("DELETE FROM rate_limit_counters WHERE key LIKE 'employee-portal-%' OR key LIKE 'send:employee-portal-invite:%'");
  await setPlatform(a, true);
  expect((await putSetting(a, true)).statusCode).toBe(200);
}, 120_000);
afterAll(async () => { await cleanup(a); });

describe('PR 1570 breaker round 2', () => {
  it('R1: no spelling of a locked address signs in (confusables, combining dot, fullwidth, Kelvin, case, padding)', async () => {
    const emp = await person(a, 'kirk.william@example.invalid');
    expect((await invite(a, emp)).statusCode).toBe(200);
    expect((await doAccept({}, { token: lastToken(), password: PW }, ip())).statusCode).toBe(200);
    for (let i = 0; i < 5; i += 1) expect((await doLogin({}, { email: 'kirk.william@example.invalid', password: `x-${i}` }, ip())).statusCode).toBe(401);
    const spellings = [
      'kirk.wİlliam@example.invalid', // dotted capital I
      'kirk.wi̇lliam@example.invalid', // i + combining dot above
      'Kirk.william@example.invalid', // Kelvin sign (NFKC -> K)
      'ｋirk.william@example.invalid', // fullwidth k (NFKC -> k)
      'KIRK.WILLIAM@EXAMPLE.INVALID',
      '  kirk.william@example.invalid\t',
      'kirk.william@xn--example-.invalid',
      'kirk.william@example.invalid.',
      'kirk.william​@example.invalid', // zero-width space
      'kirk.william@example．invalid', // fullwidth full stop
    ];
    const got: Array<[string, number]> = [];
    for (const email of spellings) got.push([email, (await doLogin({}, { email, password: PW }, ip())).statusCode]);
    expect(got.filter(([, s]) => s === 200)).toEqual([]);
  });

  it('R2: the same-origin guard refuses every cross-site or unlabelled shape', async () => {
    const base = { host: 'app.example.invalid', 'content-type': 'application/json' };
    const shapes: Record<string, Record<string, string | undefined>> = {
      noOriginNoFetchSite: { ...base },
      nullOrigin: { ...base, origin: 'null' },
      nullOriginSameOriginSite: { ...base, origin: 'null', 'sec-fetch-site': 'same-origin' },
      crossSite: { ...base, 'sec-fetch-site': 'cross-site' },
      sameSiteSibling: { ...base, origin: 'https://admin.example.invalid', 'sec-fetch-site': 'same-site' },
      fetchSiteNone: { ...base, 'sec-fetch-site': 'none' },
      originOtherHost: { ...base, origin: 'https://evil.example.invalid' },
      originHostPrefix: { ...base, origin: 'https://app.example.invalid.evil.example' },
      originUserinfo: { ...base, origin: 'https://app.example.invalid@evil.example' },
      textPlain: { host: 'app.example.invalid', 'content-type': 'text/plain', origin: 'https://app.example.invalid', 'sec-fetch-site': 'same-origin' },
      formUrlencoded: { host: 'app.example.invalid', 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' },
      jsonLookalike: { host: 'app.example.invalid', 'content-type': 'application/jsonx', 'sec-fetch-site': 'same-origin' },
    };
    const leaks: string[] = [];
    for (const [name, h] of Object.entries(shapes)) {
      for (const [route, fn] of Object.entries(portalRoutes)) {
        const r = await portal(fn, 'POST', {}, { email: 'nobody@example.invalid', password: PW, token: 'A'.repeat(43) }, ip(), h);
        if (r.statusCode !== 403) leaks.push(`${route}/${name}=${r.statusCode}`);
      }
    }
    expect(leaks).toEqual([]);
  });

  it('R3: an address change landing while an accept is between its lookup and its write opens nothing', async () => {
    const emp = await person(a, 'race-old@example.invalid');
    expect((await invite(a, emp)).statusCode).toBe(200);
    const token = lastToken();
    const real = bcrypt.hash.bind(bcrypt);
    const spy = vi.spyOn(bcrypt, 'hash').mockImplementation((async (pw: string, cost: number) => {
      // Exactly what setEmployeeEmail does, between accept's lookup and its UPDATE.
      await a.pool.query('UPDATE payroll_employees SET email = $2 WHERE id = $1', [emp, 'race-new@example.invalid']);
      await endPortalAccessForAddressChange(a.company, emp, { userId: a.admin });
      return real(pw, cost);
    }) as never);
    const jar: Record<string, string> = {};
    const acc = await doAccept(jar, { token, password: PW }, ip());
    spy.mockRestore();
    const me = await doMe(jar);
    const row = (await a.pool.query('SELECT status FROM employee_portal_access WHERE employee_id = $1', [emp])).rows[0];
    expect({ accept: acc.statusCode, me: me.statusCode, status: row?.status }).toEqual({ accept: 400, me: 401, status: 'revoked' });
  });

  it('R4: the email change committing AFTER the accept still ends the fresh session', async () => {
    const emp = await person(a, 'race2-old@example.invalid');
    expect((await invite(a, emp)).statusCode).toBe(200);
    const jar: Record<string, string> = {};
    expect((await doAccept(jar, { token: lastToken(), password: PW }, ip())).statusCode).toBe(200);
    // Only the payroll_employees write lands (as from a path that skips endPortalAccessForAddressChange).
    await a.pool.query('UPDATE payroll_employees SET email = $2 WHERE id = $1', [emp, 'race2-new@example.invalid']);
    expect((await doMe(jar)).statusCode).toBe(401);
    expect((await doLogin({}, { email: 'race2-old@example.invalid', password: PW }, ip())).statusCode).toBe(401);
  });
});
