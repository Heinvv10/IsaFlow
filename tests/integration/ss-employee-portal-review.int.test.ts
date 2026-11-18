/**
 * Wave 6 SS, review round 1 of #1570 (authz breaker + security/quality), through the real routes on two tenants.
 * Nothing here can send: see ss-employee-portal.helpers.ts. Claims:
 *  - M2a: a login whose address is no longer the one on the employee record signs nothing in and holds no session;
 *  - M2b: changing the address (PE's route) ends a pending invitation and an active login, sessions included;
 *  - L1 (login CSRF): login, accept and logout refuse anything but a same-origin JSON POST, before any write;
 *  - L2 (timing): sign-in always runs MAX_CANDIDATES bcrypt compares;
 *  - L2 (audit): an invite or revoke whose audit row fails writes nothing; a mailer that throws after the write
 *    leaves both the login and its audit row;
 *  - M (settings): a manager or a Login-as PUT is refused, the setting unchanged and nothing audited;
 *  - L3: the session check passes on app_service (the production read path), and refuses there as on the superuser;
 *  - L4: a login row pairing one company with another company's employee is refused by the database.
 *
 * Disposable DB only (rig -> assertDisposable).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import { als } from '@/lib/als';
import { currentEmployeePortalSession } from '@/lib/auth/employeePortalAuth';
import { EMPLOYEE_PORTAL_COOKIE } from '@/lib/auth/employeePortalJwt';
import { rig } from './brkr.helpers';
import { audits, loginAs, putEmail } from './pe-payslip-email.helpers';
import {
  captured, cleanup, doAccept, doLogin, doMe, invite, lastToken, person, portal, portalRoutes, putSetting, readAccess, reason,
  revoke, SAME_ORIGIN, setPlatform, throwNext, type R,
} from './ss-employee-portal.helpers';

vi.hoisted(() => { process.env.PORTAL_JWT_SECRET ??= 'ss-employee-portal-secret-for-tests-0123456789abcdef'; });

let a: R;
let b: R;
const PW = 'correct horse battery';
let ip = 0;
const nextIp = () => { ip += 1; return `198.18.2.${ip}`; };
const status = async (emp: string) => (await a.pool.query('SELECT status FROM employee_portal_access WHERE employee_id = $1', [emp])).rows[0]?.status;

async function onboard(r: R, employeeId: string): Promise<Record<string, string>> {
  expect((await invite(r, employeeId)).statusCode).toBe(200);
  const jar: Record<string, string> = {};
  expect((await doAccept(jar, { token: lastToken(), password: PW }, nextIp())).statusCode).toBe(200);
  return jar;
}

beforeAll(async () => {
  a = await rig('employee-portal-review-a');
  b = await rig('employee-portal-review-b');
  await a.setup();
  await b.setup();
  await a.pool.query("DELETE FROM rate_limit_counters WHERE key LIKE 'employee-portal-%' OR key LIKE 'send:employee-portal-invite:%'");
  await setPlatform(a, true);
  expect((await putSetting(a, true)).statusCode).toBe(200);
}, 120_000);
afterAll(async () => {
  for (const r of [a, b]) await cleanup(r);
  expect(captured.every((m) => [m.to].flat().every((to) => String(to).endsWith('@example.invalid')))).toBe(true);
});

describe('employee portal, review round 1', () => {
  it('M2a: a login whose address is no longer on file signs nothing in and holds no session', async () => {
    const emp = await person(a, 'moved@example.invalid');
    const jar = await onboard(a, emp);
    expect((await doMe(jar)).statusCode).toBe(200);
    await a.pool.query('UPDATE payroll_employees SET email = $2 WHERE id = $1', [emp, 'Moved-Elsewhere@example.invalid']);
    expect((await doMe(jar)).statusCode).toBe(401);
    expect((await doLogin({}, { email: 'moved@example.invalid', password: PW }, nextIp())).statusCode).toBe(401);
    // The same address on file again, in another case: the login is the employee's again.
    await a.pool.query('UPDATE payroll_employees SET email = $2 WHERE id = $1', [emp, 'MOVED@example.invalid']);
    expect((await doMe(jar)).statusCode).toBe(200);
  });

  it('M2b: changing the address ends a pending invitation and an active login, with its sessions', async () => {
    const pending = await person(a, 'pending@example.invalid');
    expect((await invite(a, pending)).statusCode).toBe(200);
    const token = lastToken();
    const before = await audits(a, 'employee_portal_access');
    expect((await putEmail(a, pending, { email: 'pending-new@example.invalid' })).statusCode).toBe(200);
    const late = await doAccept({}, { token, password: PW }, nextIp());
    expect([late.statusCode, reason(late), await status(pending)]).toEqual([400, 'INVITE_INVALID', 'revoked']);

    const active = await person(a, 'active@example.invalid');
    const jar = await onboard(a, active);
    // Changed back and forth, the old session stays dead: the login was revoked and its version bumped.
    expect((await putEmail(a, active, { email: 'active-new@example.invalid' })).statusCode).toBe(200);
    expect((await putEmail(a, active, { email: 'active@example.invalid' })).statusCode).toBe(200);
    expect([(await doMe(jar)).statusCode, await status(active)]).toEqual([401, 'revoked']);
    expect((await doLogin({}, { email: 'active@example.invalid', password: PW }, nextIp())).statusCode).toBe(401);
    expect(await audits(a, 'employee_portal_access')).toBe(before + 3); // pending ended, active invited, active ended
    // The employer sees the address now on file and invites it afresh.
    expect((await readAccess(a, active)).body.data).toMatchObject({ status: 'revoked', email: 'active@example.invalid' });
  });

  it('L1: login, accept and logout refuse anything but a same-origin JSON POST, before any write', async () => {
    const emp = await person(a, 'csrf@example.invalid');
    expect((await invite(a, emp)).statusCode).toBe(200);
    const token = lastToken();
    const hostile: Array<Record<string, string | undefined>> = [
      { ...SAME_ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
      { ...SAME_ORIGIN, 'content-type': 'text/plain' },
      { ...SAME_ORIGIN, origin: 'https://evil.example.invalid', 'sec-fetch-site': undefined },
      { ...SAME_ORIGIN, 'sec-fetch-site': 'cross-site' },
      { ...SAME_ORIGIN, 'sec-fetch-site': 'same-site' },
      { ...SAME_ORIGIN, origin: undefined, 'sec-fetch-site': undefined },
    ];
    for (const h of hostile) {
      const jar: Record<string, string> = {};
      const acc = await portal(portalRoutes.accept, 'POST', jar, { token, password: PW }, nextIp(), h);
      const log = await portal(portalRoutes.login, 'POST', jar, { email: 'csrf@example.invalid', password: PW }, nextIp(), h);
      const out = await portal(portalRoutes.logout, 'POST', { [EMPLOYEE_PORTAL_COOKIE]: 'x' }, {}, nextIp(), h);
      expect([acc.statusCode, log.statusCode, out.statusCode, acc.headers.get('set-cookie'), out.headers.get('set-cookie')])
        .toEqual([403, 403, 403, undefined, undefined]);
    }
    expect(await status(emp)).toBe('invited');
    // The browser's own same-origin POST works (Origin alone, as some browsers send it, too).
    const jar: Record<string, string> = {};
    const ok = await portal(portalRoutes.accept, 'POST', jar, { token, password: PW }, nextIp(), { ...SAME_ORIGIN, 'sec-fetch-site': undefined });
    expect([ok.statusCode, await status(emp)]).toEqual([200, 'active']);
    expect((await portal(portalRoutes.logout, 'POST', jar, {}, nextIp())).statusCode).toBe(200);
  });

  it('L2: sign-in runs the same number of bcrypt compares for an unknown address, a wrong password and a right one', async () => {
    const emp = await person(a, 'timing@example.invalid');
    await onboard(a, emp);
    const spy = vi.spyOn(bcrypt, 'compare');
    const counts: number[] = [];
    try {
      for (const body of [
        { email: 'nobody-here@example.invalid', password: PW }, { email: 'timing@example.invalid', password: 'wrong guess here' },
        { email: 'timing@example.invalid', password: PW },
      ]) {
        spy.mockClear();
        await doLogin({}, body, nextIp());
        counts.push(spy.mock.calls.length);
      }
    } finally {
      spy.mockRestore();
    }
    expect(counts).toEqual([5, 5, 5]);
  });

  it('L2: an invite or revoke whose audit row cannot be written changes nothing', async () => {
    const emp = await person(a, 'audit-fail@example.invalid');
    const sent = captured.length;
    await a.pool.query(`ALTER TABLE audit_log ADD CONSTRAINT ss_review_no_portal_audit
      CHECK (entity_type <> 'employee_portal_access') NOT VALID`);
    try {
      expect((await invite(a, emp)).statusCode).toBe(500);
      expect([await status(emp), captured.length]).toEqual([undefined, sent]);
    } finally {
      await a.pool.query('ALTER TABLE audit_log DROP CONSTRAINT ss_review_no_portal_audit');
    }
    expect((await invite(a, emp)).statusCode).toBe(200);
    await a.pool.query(`ALTER TABLE audit_log ADD CONSTRAINT ss_review_no_portal_audit
      CHECK (entity_type <> 'employee_portal_access') NOT VALID`);
    try {
      expect((await revoke(a, emp)).statusCode).toBe(500);
      expect(await status(emp)).toBe('invited');
    } finally {
      await a.pool.query('ALTER TABLE audit_log DROP CONSTRAINT ss_review_no_portal_audit');
    }
  });

  it('L2: a mailer that throws after the write leaves the login row AND its audit row (one transaction, committed)', async () => {
    const emp = await person(a, 'mailer-crash@example.invalid');
    const before = await audits(a, 'employee_portal_access');
    throwNext.count = 1;
    expect((await invite(a, emp)).statusCode).toBe(500);
    // The request's own transaction rolled back (500); the login and its audit, written together on migration_admin,
    // did not. An audit written on the request's pool would be gone with it.
    expect([await status(emp), await audits(a, 'employee_portal_access')]).toEqual(['invited', before + 1]);
    expect((await invite(a, emp)).statusCode).toBe(200);
  });

  it('M: a manager or a Login-as cannot change the company setting; nothing changes and nothing is audited', async () => {
    const before = await audits(a, 'payroll_company_settings');
    const manager = await putSetting(a, false, { user: await a.addUser('manager') });
    const imp = await putSetting(a, false, { user: await loginAs(a, a.admin) });
    expect([manager.statusCode, imp.statusCode]).toEqual([403, 403]);
    expect(imp.body.error?.details?.reason ?? imp.body.error?.code).toBe('IMPERSONATION_FORBIDDEN');
    const setting = (await a.pool.query('SELECT employee_portal_enabled FROM payroll_company_settings WHERE company_id = $1', [a.company])).rows[0];
    expect([setting?.employee_portal_enabled, await audits(a, 'payroll_company_settings')]).toEqual([true, before]);
  });

  it('L3: the session check reads through app_service, the production login role, and refuses there too', async () => {
    const emp = await person(a, 'service-role@example.invalid');
    const jar = await onboard(a, emp);
    const asService = async (cookie: string | undefined) => {
      const client = await a.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE app_service');
        const role = (await client.query('SELECT current_user AS u')).rows[0]!.u as string;
        const session = await als.run({ client, claims: {} } as never, () => currentEmployeePortalSession(cookie));
        return { role, session };
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    };
    const ok = await asService(jar[EMPLOYEE_PORTAL_COOKIE]);
    expect([ok.role, ok.session?.employeeId]).toEqual(['app_service', emp]);
    expect((await revoke(a, emp)).statusCode).toBe(200);
    expect((await asService(jar[EMPLOYEE_PORTAL_COOKIE])).session).toBeNull();
  });

  it('L4: a login row naming another company\'s employee is refused by the database', async () => {
    const theirs = await person(b, 'b-employee@example.invalid');
    await expect(a.pool.query(
      `INSERT INTO employee_portal_access (company_id, employee_id, email, status, invite_token_hash, invite_expires_at, invited_by)
       VALUES ($1, $2, 'b-employee@example.invalid', 'invited', repeat('a', 64), now() + interval '1 day', 'x')`, [a.company, theirs],
    )).rejects.toMatchObject({ code: '23503' });
    // And a mixed-case or non-ASCII address is refused too (stored only in the portal's one spelling, M1).
    for (const email of ['B-Employee@example.invalid', 'b-émployee@example.invalid']) {
      await expect(a.pool.query(
        `INSERT INTO employee_portal_access (company_id, employee_id, email, status, invite_token_hash, invite_expires_at, invited_by)
         VALUES ($1, $2, $3, 'invited', repeat('b', 64), now() + interval '1 day', 'x')`, [b.company, theirs, email],
      )).rejects.toMatchObject({ code: '23514' });
    }
  });
});
