/**
 * Wave 6 SS: the employee portal's login (migration 999u), through the real routes on two tenants: the staff invite
 * route (withAuth, app_user, RLS) built with a CAPTURE mailer, and the portal's accept / login / me routes with a
 * cookie jar. Nothing here can send: see ss-employee-portal.helpers.ts.
 * Claims:
 *  - every invite refusal (platform switch off even with the company setting on; setting off; Login-as; an agent; a
 *    manager; another tenant's employee; no address) sends nothing and writes no login;
 *  - an invite mails a one-time link (token in the fragment, only its hash stored); app roles cannot read the secrets
 *    or write the table; accepting it signs the employee in, and the link does not work twice;
 *  - the session is the portal's own: an AR portal cookie, an AR-key token with this portal's claims, a staff token
 *    and a token naming another company's login are all refused;
 *  - the brute-force limit holds per address whatever the IP; a revoke ends the login and every session; the platform
 *    switch turned off ends sessions; a leaver signs in until the end of the next tax year, then not;
 *  - one address at two employers must choose, and is shown only those employers.
 *
 * Disposable DB only (rig -> assertDisposable).
 */
import { createHash } from 'crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';
import { signArPortalToken } from '@/lib/auth/arPortalJwt';
import { signEmployeePortalToken } from '@/lib/auth/employeePortalJwt';
import { leaverAccessEnds, todaySast } from '@/modules/accounting/services/payroll/employeePortalWindow';
import { rig } from './brkr.helpers';
import { agent, asAppUser, loginAs } from './pe-payslip-email.helpers';
import {
  captured, cleanup, doAccept, doLogin, doMe, failNext, invite, lastToken, person, putSetting, readAccess, reason, revoke,
  setPlatform, type R,
} from './ss-employee-portal.helpers';

vi.hoisted(() => { process.env.PORTAL_JWT_SECRET ??= 'ss-employee-portal-secret-for-tests-0123456789abcdef'; });

let a: R;
let b: R;
const PW = 'correct horse battery';
const rows = async (r: R) => Number((await r.pool.query('SELECT count(*) FROM employee_portal_access WHERE company_id = $1', [r.company])).rows[0]!.count);

let onboarded = 0;
/** Invites, accepts (each from its own IP: the accept limit is per IP) and returns a signed-in jar. */
async function onboard(r: R, employeeId: string, password = PW): Promise<Record<string, string>> {
  const inv = await invite(r, employeeId);
  if (inv.statusCode !== 200) throw new Error(`invite: ${inv.statusCode} ${JSON.stringify(inv.body)}`);
  const jar: Record<string, string> = {};
  onboarded += 1;
  const acc = await doAccept(jar, { token: lastToken(), password }, `198.18.0.${onboarded}`);
  if (acc.statusCode !== 200) throw new Error(`accept: ${acc.statusCode} ${JSON.stringify(acc.body)}`);
  return jar;
}

beforeAll(async () => {
  a = await rig('employee-portal-a');
  b = await rig('employee-portal-b');
  await a.setup();
  await b.setup();
  await a.pool.query("DELETE FROM rate_limit_counters WHERE key LIKE 'employee-portal-%' OR key LIKE 'send:employee-portal-invite:%'");
}, 120_000);
afterAll(async () => {
  for (const r of [a, b]) await cleanup(r);
  expect(captured.length).toBeGreaterThan(0);
  expect(captured.every((m) => [m.to].flat().every((to) => String(to).endsWith('@example.invalid')))).toBe(true);
});

describe('employee portal login', () => {
  it('refuses an invite before anything is sent or written', async () => {
    const emp = await person(a, 'refused@example.invalid');
    const bEmp = await person(b, 'other-tenant@example.invalid');
    const noEmail = await person(a, null);
    // The company setting on does not open the platform switch (F7: a client admin cannot make the first invite).
    expect((await putSetting(a, true)).statusCode).toBe(200);
    const off = await invite(a, emp);
    expect([off.statusCode, reason(off)]).toEqual([403, 'FEATURE_DISABLED']);
    await setPlatform(a, true);
    expect((await putSetting(a, false)).statusCode).toBe(200);
    const settingOff = await invite(a, emp);
    expect([settingOff.statusCode, reason(settingOff)]).toEqual([403, 'PORTAL_OFF']);
    expect((await putSetting(a, true)).statusCode).toBe(200);

    const imp = await invite(a, emp, { user: await loginAs(a, a.admin) });
    expect([imp.statusCode, imp.body.error?.details?.reason ?? imp.body.error?.code]).toEqual([403, 'IMPERSONATION_FORBIDDEN']);
    const bot = await invite(a, emp, { user: await agent(a, a.admin) });
    expect([bot.statusCode, reason(bot)]).toEqual([403, 'AGENT_FORBIDDEN']);
    expect((await invite(a, emp, { user: await a.addUser('manager') })).statusCode).toBe(403);
    expect((await invite(a, bEmp)).statusCode).toBe(404);
    expect((await readAccess(a, bEmp)).statusCode).toBe(404);
    const none = await invite(a, noEmail);
    expect([none.statusCode, reason(none)]).toEqual([409, 'NO_EMAIL']);
    expect([await rows(a), await rows(b), captured.length]).toEqual([0, 0, 0]);
  });

  it('invites with a one-time link whose secret only migration_admin can read, and accepting it signs in', async () => {
    const emp = await person(a, 'thandi@example.invalid');
    expect((await invite(a, emp)).body.data).toEqual({ status: 'invited', sent: true });
    expect(captured.at(-1)!.to).toBe('thandi@example.invalid');
    const token = lastToken();
    expect(captured.at(-1)!.html).not.toContain('?t=');
    const stored = (await a.pool.query('SELECT invite_token_hash, password_hash, status FROM employee_portal_access WHERE employee_id = $1', [emp])).rows[0]!;
    expect(stored).toEqual({ invite_token_hash: createHash('sha256').update(token).digest('hex'), password_hash: null, status: 'invited' });
    // 937's rule: no app role reads the secrets or writes the table.
    await expect(asAppUser(a, a.admin, (q) => q('SELECT password_hash FROM employee_portal_access'))).rejects.toThrow(/permission denied/);
    await expect(asAppUser(a, a.admin, (q) => q("UPDATE employee_portal_access SET status = 'active'"))).rejects.toThrow(/permission denied/);
    expect((await asAppUser(a, a.admin, (q) => q('SELECT status FROM employee_portal_access'))).rows).toEqual([{ status: 'invited' }]);

    const jar: Record<string, string> = {};
    const weak = await doAccept(jar, { token, password: 'short' });
    expect([weak.statusCode, reason(weak)]).toEqual([400, 'WEAK_PASSWORD']);
    const forged = await doAccept(jar, { token: 'A'.repeat(43), password: PW });
    expect([forged.statusCode, reason(forged)]).toEqual([400, 'INVITE_INVALID']);
    const ok = await doAccept(jar, { token, password: PW });
    expect(ok.statusCode).toBe(200);
    expect(String(ok.headers.get('set-cookie'))).toMatch(/employee_portal_session=.+HttpOnly.*SameSite=Strict/i);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    const again = await doAccept({}, { token, password: 'another long password' });
    expect([again.statusCode, reason(again)]).toEqual([400, 'INVITE_INVALID']);
    const whoami = await doMe(jar);
    expect([whoami.statusCode, whoami.body.data?.employeeName]).toEqual([200, `Thandi ${(await a.pool.query('SELECT last_name FROM payroll_employees WHERE id = $1', [emp])).rows[0]!.last_name}`]);
    expect((await readAccess(a, emp)).body.data?.status).toBe('active');
    const twice = await invite(a, emp);
    expect([twice.statusCode, reason(twice)]).toEqual([409, 'ALREADY_ACTIVE']);
  });

  it('reports a failed invitation send and lets the employer invite again', async () => {
    const emp = await person(a, 'bounce@example.invalid');
    failNext.count = 1;
    expect((await invite(a, emp)).body.data).toMatchObject({ status: 'invited', sent: false });
    expect((await invite(a, emp)).body.data).toEqual({ status: 'invited', sent: true });
  });

  it('refuses every session that is not this portal\'s own, or names another company\'s login', async () => {
    const emp = await person(a, 'session@example.invalid');
    const jar = await onboard(a, emp);
    const accessId = (await a.pool.query('SELECT id FROM employee_portal_access WHERE employee_id = $1', [emp])).rows[0]!.id as string;
    const claims = { accessId, companyId: a.company, employeeId: emp, sessionVersion: 1 };
    // The AR portal's own cookie, and an AR-portal token in this portal's cookie.
    const ar = await signArPortalToken({ clientId: emp, companyId: a.company, email: 'session@example.invalid' });
    expect((await doMe({ portal_session: ar })).statusCode).toBe(401);
    expect((await doMe({ employee_portal_session: ar })).statusCode).toBe(401);
    // This portal's claims, signed with the AR/AFS portals' key itself: refused (the key is derived).
    const arKey = await new SignJWT({ cid: a.company, eid: emp, sv: 1 }).setProtectedHeader({ alg: 'HS256' }).setSubject(accessId)
      .setAudience('isaflow-employee-portal').setExpirationTime('1h').sign(new TextEncoder().encode(process.env.PORTAL_JWT_SECRET));
    expect((await doMe({ employee_portal_session: arKey })).statusCode).toBe(401);
    // A staff session token.
    expect((await doMe({ employee_portal_session: a.tokens[a.admin]!, 'sb-access-token': a.tokens[a.admin]! })).statusCode).toBe(401);
    // Validly signed, but naming company B for A's login, or another employee: no such login.
    expect((await doMe({ employee_portal_session: await signEmployeePortalToken({ ...claims, companyId: b.company }) })).statusCode).toBe(401);
    const other = await person(a, null, 'Other');
    expect((await doMe({ employee_portal_session: await signEmployeePortalToken({ ...claims, employeeId: other }) })).statusCode).toBe(401);
    expect((await doMe(jar)).statusCode).toBe(200);
  });

  it('holds the brute-force limit per address whatever the IP, and per IP whatever the address', async () => {
    const emp = await person(a, 'brute@example.invalid');
    await onboard(a, emp);
    for (let i = 0; i < 5; i += 1) {
      const wrong = await doLogin({}, { email: 'brute@example.invalid', password: `wrong-guess-${i}` }, `203.0.113.${i + 1}`);
      expect(wrong.statusCode).toBe(401);
    }
    const right = await doLogin({}, { email: 'BRUTE@example.invalid', password: PW }, '203.0.113.99');
    expect([right.statusCode, reason(right)]).toEqual([429, 'RATE_LIMITED']);
    // An unknown address answers like a wrong password, and spreading addresses from one IP stops at 20.
    const ip = '192.0.2.50';
    for (let i = 0; i < 20; i += 1) expect((await doLogin({}, { email: `nobody-${i}@example.invalid`, password: PW }, ip)).statusCode).toBe(401);
    expect((await doLogin({}, { email: 'nobody-x@example.invalid', password: PW }, ip)).statusCode).toBe(429);
  });

  it('a revoke ends the login and every session; a re-invite starts afresh', async () => {
    const emp = await person(a, 'revoke@example.invalid');
    const jar = await onboard(a, emp);
    expect((await revoke(a, emp, { user: await a.addUser('manager') })).statusCode).toBe(403);
    expect((await revoke(a, emp)).body.data?.status).toBe('revoked');
    expect((await doMe(jar)).statusCode).toBe(401);
    expect((await doLogin({}, { email: 'revoke@example.invalid', password: PW }, '192.0.2.60')).statusCode).toBe(401);
    const jar2 = await onboard(a, emp, 'a brand new password');
    expect((await doMe(jar2)).statusCode).toBe(200);
    expect((await doMe(jar)).statusCode).toBe(401);
  });

  it('the platform switch or the company setting turned off ends sessions and logins', async () => {
    const emp = await person(a, 'switch@example.invalid');
    const jar = await onboard(a, emp);
    await setPlatform(a, false);
    expect((await doMe(jar)).statusCode).toBe(401);
    const off = await doLogin({}, { email: 'switch@example.invalid', password: PW }, '192.0.2.70');
    expect([off.statusCode, reason(off)]).toEqual([403, 'FEATURE_DISABLED']);
    await setPlatform(a, true);
    expect((await doMe(jar)).statusCode).toBe(200);
    expect((await putSetting(a, false)).statusCode).toBe(200);
    expect((await doMe(jar)).statusCode).toBe(401);
    expect((await putSetting(a, true)).statusCode).toBe(200);
  });

  it('a leaver signs in until the end of the next tax year, then the login is disabled', async () => {
    const emp = await person(a, 'leaver@example.invalid');
    const jar = await onboard(a, emp);
    // Left today: access to the end of the next tax year, after today whenever the suite runs.
    await a.pool.query("UPDATE payroll_employees SET end_date = $2, status = 'terminated' WHERE id = $1", [emp, todaySast()]);
    expect((await doMe(jar)).statusCode).toBe(200);
    expect((await readAccess(a, emp)).body.data?.accessEnds).toBe(leaverAccessEnds(todaySast()));
    expect((await doLogin({}, { email: 'leaver@example.invalid', password: PW }, '192.0.2.80')).statusCode).toBe(200);
    // Left three years ago: the next tax year ended at least a year ago (the boundaries: employeePortalWindow.test.ts).
    await a.pool.query("UPDATE payroll_employees SET end_date = $2::date - interval '3 years' WHERE id = $1", [emp, todaySast()]);
    expect((await doMe(jar)).statusCode).toBe(401);
    const ended = await doLogin({}, { email: 'leaver@example.invalid', password: PW }, '192.0.2.81');
    expect([ended.statusCode, reason(ended)]).toEqual([403, 'ACCESS_ENDED']);
    const reinvite = await invite(a, emp);
    expect([reinvite.statusCode, reason(reinvite)]).toEqual([403, 'ACCESS_ENDED']);
  });

  it('one address at two employers chooses, and sees only those employers', async () => {
    await setPlatform(b, true);
    expect((await putSetting(b, true)).statusCode).toBe(200);
    const inA = await person(a, 'two-jobs@example.invalid');
    const inB = await person(b, 'two-jobs@example.invalid');
    await onboard(a, inA);
    await onboard(b, inB);
    const both = await doLogin({}, { email: 'two-jobs@example.invalid', password: PW }, '192.0.2.90');
    expect([both.statusCode, reason(both)]).toEqual([409, 'CHOOSE_EMPLOYER']);
    const employers = both.body.error?.details?.employers as Array<{ accessId: string }>;
    expect(employers).toHaveLength(2);
    const bAccess = (await b.pool.query('SELECT id FROM employee_portal_access WHERE employee_id = $1', [inB])).rows[0]!.id;
    const jar: Record<string, string> = {};
    expect((await doLogin(jar, { email: 'two-jobs@example.invalid', password: PW, accessId: bAccess }, '192.0.2.91')).statusCode).toBe(200);
    const whoami = await doMe(jar);
    expect(whoami.body.data?.employer).toBe((await b.pool.query('SELECT name FROM companies WHERE id = $1', [b.company])).rows[0]!.name);
  });
});
