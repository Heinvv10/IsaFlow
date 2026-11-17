/**
 * Wave 6 PE: the company switch and the employee's payslip address, through the real routes (withAuth, app_user,
 * RLS) on two tenants. Claims:
 *  - the switch: payroll-detail roles read it (with the platform switch, which nobody here can set); only an owner
 *    or admin in their own session sets it; Login-as and a manager are refused with nothing written; each change is
 *    audited once and an unchanged value writes nothing;
 *  - the address: judged before any write (a second recipient, a header, a dot-less domain: 400, row unchanged);
 *    stored trimmed, cleared by a blank, audited with before and after; another tenant's employee is 404; Login-as
 *    is refused; the database CHECK refuses what the route refuses;
 *  - as bank details: a manager may set the FIRST address, but changing or clearing one already set needs an owner or
 *    admin (403, row and audit unchanged), so a manager cannot redirect payslips to themselves.
 *
 * Disposable DB only (rig -> assertDisposable).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rig } from './brkr.helpers';
import { audits, cleanup, enablePlatform, getSetting, loginAs, putEmail, putSetting, type R } from './pe-payslip-email.helpers';

let a: R;
let b: R;
let emp = '';
let bEmp = '';
const stored = async (r: R, id: string) => (await r.pool.query('SELECT email FROM payroll_employees WHERE id = $1', [id])).rows[0]!.email;
const setting = async (r: R) => (await r.pool.query(
  'SELECT payslip_email_enabled AS on, updated_by FROM payroll_company_settings WHERE company_id = $1', [r.company])).rows[0];

beforeAll(async () => {
  a = await rig('payslip-email-settings-a');
  b = await rig('payslip-email-settings-b');
  await a.setup();
  await b.setup();
  emp = (await a.employee(20000)).employee;
  bEmp = (await b.employee(20000)).employee;
}, 120_000);
afterAll(async () => {
  for (const r of [a, b]) await cleanup(r);
});

describe('the company switch', () => {
  it('is off by default, and the platform switch is reported, never set', async () => {
    expect((await getSetting(a)).body.data).toEqual({ platformEnabled: false, enabled: false });
    await enablePlatform(a);
    expect((await getSetting(a)).body.data).toEqual({ platformEnabled: true, enabled: false });
    expect((await getSetting(b)).body.data).toEqual({ platformEnabled: false, enabled: false });
  });

  it('only an owner or admin in their own session sets it; refusals write nothing', async () => {
    const manager = await a.addUser('manager');
    expect((await getSetting(a, { user: manager })).statusCode).toBe(200);
    expect((await putSetting(a, true, { user: manager })).statusCode).toBe(403);
    const imp = await putSetting(a, true, { user: await loginAs(a, a.admin) });
    expect(imp.statusCode).toBe(403);
    expect(JSON.stringify(imp.body)).toContain('IMPERSONATION_FORBIDDEN');
    expect((await putSetting(a, 'yes')).statusCode).toBe(400);
    expect(await setting(a)).toBeUndefined();
    expect(await audits(a, 'payroll_company_settings')).toBe(0);
  });

  it('a change is audited once, stamped with the session user; the same value again writes nothing', async () => {
    const on = await putSetting(a, true);
    expect(on.body.data).toEqual({ platformEnabled: true, enabled: true });
    expect(await setting(a)).toEqual({ on: true, updated_by: a.admin });
    await putSetting(a, true);
    expect(await audits(a, 'payroll_company_settings')).toBe(1);
    expect((await getSetting(b)).body.data!.enabled).toBe(false);
  });
});

describe('the employee\'s payslip address', () => {
  it('refuses anything but one plain address, before any write', async () => {
    for (const bad of ['a@x.io, b@x.io', 'a@x.io\r\nBcc: c@x.io', 'a@b', 'Name <a@x.io>', 'a b@x.io', 12, `${'a'.repeat(250)}@x.io`]) {
      const res = await putEmail(a, emp, { email: bad });
      expect(res.statusCode, String(bad)).toBe(400);
    }
    expect((await putEmail(a, emp, { email: 'a@example.invalid', name: 'x' })).statusCode).toBe(400);
    expect(await stored(a, emp)).toBeNull();
    expect(await audits(a, 'payroll_employee')).toBe(0);
  });

  it('stores it trimmed, clears it with a blank, audits each change with before and after', async () => {
    const res = await putEmail(a, emp, { email: '  thandi@example.invalid ' });
    expect([res.statusCode, res.body.data]).toEqual([200, { email: 'thandi@example.invalid' }]);
    expect(await stored(a, emp)).toBe('thandi@example.invalid');
    await putEmail(a, emp, { email: 'thandi@example.invalid' }); // unchanged: no audit row
    expect((await putEmail(a, emp, { email: '' })).body.data).toEqual({ email: null });
    expect(await stored(a, emp)).toBeNull();
    const rows = (await a.pool.query(
      "SELECT changes FROM audit_log WHERE company_id = $1 AND entity_type = 'payroll_employee' ORDER BY created_at", [a.company])).rows;
    expect(rows.map((r) => r.changes.fields[0])).toEqual([
      { field: 'email', old: null, new: 'thandi@example.invalid', label: 'Payslip email' },
      { field: 'email', old: 'thandi@example.invalid', new: null, label: 'Payslip email' },
    ]);
  });

  it('a manager may set the first address but not change or clear it; an admin may', async () => {
    const manager = await a.addUser('manager');
    const fresh = (await a.employee(15000)).employee;
    expect((await putEmail(a, fresh, { email: 'first@example.invalid' }, { user: manager })).statusCode).toBe(200);
    const audited = await audits(a, 'payroll_employee');
    for (const email of ['manager-own@example.invalid', null]) {
      const res = await putEmail(a, fresh, { email }, { user: manager });
      expect(res.statusCode, String(email)).toBe(403);
    }
    expect(await stored(a, fresh)).toBe('first@example.invalid');
    expect(await audits(a, 'payroll_employee')).toBe(audited);
    expect((await putEmail(a, fresh, { email: 'changed@example.invalid' })).statusCode).toBe(200);
    expect(await stored(a, fresh)).toBe('changed@example.invalid');
    expect(await audits(a, 'payroll_employee')).toBe(audited + 1);
  });

  it('another tenant\'s employee is 404; Login-as is refused; the CHECK holds the same rule', async () => {
    expect((await putEmail(a, bEmp, { email: 'x@example.invalid' })).statusCode).toBe(404);
    expect(await stored(b, bEmp)).toBeNull();
    const imp = await putEmail(a, emp, { email: 'x@example.invalid' }, { user: await loginAs(a, a.admin, 'login-as-2') });
    expect(imp.statusCode).toBe(403);
    expect(await stored(a, emp)).toBeNull();
    await expect(a.pool.query("UPDATE payroll_employees SET email = 'a@x.io;b@x.io' WHERE id = $1", [emp]))
      .rejects.toThrow(/payroll_employees_email_check/);
  });
});
