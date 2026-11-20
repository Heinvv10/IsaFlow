/**
 * Wave 6 PSP-H on real Postgres (migration 1015): a PSP's entity particulars. The CHECKs (only a PSP holds them, the 9-prefixed
 * tax reference, the lengths), the PATCH route for two tenants (judged, cleared on moving off PSP, refused for Login-as).
 * Disposable DB only.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanSeveranceFixtures, type SeveranceFixture } from './p3-severance.helpers';
import { seedEmployee } from './p4fu-cumulative.helpers';
import { addEmployee } from './ts-b.helpers';
import { routeCaller, type Route } from './w3-01-payroll.helpers';
import { impersonationToken } from './r035-pr2.helpers';
import employeeRoute from '../../pages/api/payroll/employees/[id]';
import { updatePayrollEmployee } from '@/modules/accounting/services/payroll/payrollEmployeeService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const fixtures: SeveranceFixture[] = [];
const managers: string[] = [];
afterAll(async () => {
  try {
    await pool.query('DELETE FROM company_users WHERE user_id = ANY($1)', [managers]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [managers]);
    await pool.query('DELETE FROM impersonation_sessions WHERE actor_user_id = ANY($1)', [fixtures.map((f) => f.approver)]);
    await cleanSeveranceFixtures(pool, fixtures);
  } finally { await pool.end(); }
});

const code = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return (e as { code?: string }).code ?? String(e); } };
const row = async (id: string) => (await pool.query(
  'SELECT tax_status, psp_entity_name, psp_registration_number, psp_tax_reference FROM payroll_employees WHERE id = $1', [id])).rows[0];
const GOOD = { pspEntityName: 'Acme Consulting (Pty) Ltd', pspRegistrationNumber: '2015/123456/07', pspTaxReference: '9012345675' };

describe('1015: the CHECKs', () => {
  it('only a PSP holds particulars; the tax reference is 10 digits starting with 9; names are 1-120, numbers 1-30', async () => {
    const f = await seedEmployee(pool, fixtures, 'psph checks', 20_000);
    const set = (status: string, entity: string | null, name: string | null, reg: string | null, tax: string | null) => pool.query(
      `UPDATE payroll_employees SET tax_status = $2, psp_entity_type = $3, psp_entity_name = $4, psp_registration_number = $5, psp_tax_reference = $6
        WHERE id = $1`, [f.employee, status, entity, name, reg, tax]);
    expect(await code(set('employee', null, 'Acme', null, null))).toBe('23514');
    expect(await code(set('personal_service_provider', 'company', 'Acme', '2015/123456/07', '9012345675'))).toBeNull();
    expect(await code(set('personal_service_provider', 'company', 'Acme', null, '0123456789'))).toBe('23514');
    expect(await code(set('personal_service_provider', 'company', ' ', null, null))).toBe('23514');
    expect(await code(set('personal_service_provider', 'company', 'x'.repeat(121), null, null))).toBe('23514');
    expect(await code(set('personal_service_provider', 'trust', 'Acme Trust', 'x'.repeat(31), null))).toBe('23514');
    // e@syFile field injection (security review): no quote, CR / LF, other control character, comma or pipe in 3030 / 3066.
    for (const bad of ['Acme "X"', 'Acme\r\n3020,"N"', 'Acme\tCo', 'Acme\x7f', 'Acme, Co', 'Acme|Co']) {
      expect(await code(set('personal_service_provider', 'company', bad, null, null)), JSON.stringify(bad)).toBe('23514');
      expect(await code(set('personal_service_provider', 'trust', 'Acme', bad, null)), JSON.stringify(bad)).toBe('23514');
    }
    expect(await code(set('employee', null, null, null, null))).toBeNull();
  });
});

const history = async (id: string) => (await pool.query(
  `SELECT field_name, old_value, new_value FROM payroll_employee_history WHERE employee_id = $1
    AND field_name IN ('psp_entity_name', 'psp_registration_number', 'psp_tax_reference') ORDER BY created_at, field_name`, [id])).rows;

describe('the PATCH route', () => {
  it('a PSP saves its particulars; the other tenant cannot; a bad number is refused with no row changed; moving off PSP clears them', async () => {
    const a = await seedEmployee(pool, fixtures, 'psph route A', 20_000);
    const b = await seedEmployee(pool, fixtures, 'psph route B', 20_000);
    const psp = await addEmployee(pool, a, 'psph-a', 40_000);
    await updatePayrollEmployee(psp, a.company, { taxStatus: 'personal_service_provider', pspEntityType: 'company' });
    const url = `/api/payroll/employees/${psp}`;
    const ok = await a.call(employeeRoute as Route, 'PATCH', url, psp, { body: GOOD });
    expect(ok.statusCode, JSON.stringify(ok.body)).toBe(200);
    expect(await row(psp)).toEqual({ tax_status: 'personal_service_provider', psp_entity_name: GOOD.pspEntityName,
      psp_registration_number: GOOD.pspRegistrationNumber, psp_tax_reference: GOOD.pspTaxReference });
    const bad = await a.call(employeeRoute as Route, 'PATCH', url, psp, { body: { pspTaxReference: '0123456789' } });
    expect(bad.statusCode).toBe(400);
    expect((await row(psp)).psp_tax_reference).toBe(GOOD.pspTaxReference);
    const cross = await b.call(employeeRoute as Route, 'PATCH', url, psp, { body: { pspEntityName: 'Hijack' } });
    expect(cross.statusCode).toBe(404);
    expect((await row(psp)).psp_entity_name).toBe(GOOD.pspEntityName);
    const off = await a.call(employeeRoute as Route, 'PATCH', url, psp, { body: { taxStatus: 'employee' } });
    expect(off.statusCode, JSON.stringify(off.body)).toBe(200);
    expect(await row(psp)).toEqual({ tax_status: 'employee', psp_entity_name: null, psp_registration_number: null, psp_tax_reference: null });
    const notPsp = await a.call(employeeRoute as Route, 'PATCH', url, psp, { body: { pspEntityName: 'Acme' } });
    expect(notPsp.statusCode).toBe(400);
  });

  it('M1: moving trust -> company with a stored trust number is refused (422, named), nothing written; with a company number it saves', async () => {
    const f = await seedEmployee(pool, fixtures, 'psph m1', 20_000);
    const psp = await addEmployee(pool, f, 'psph-m1', 40_000);
    await updatePayrollEmployee(psp, f.company, { taxStatus: 'personal_service_provider', pspEntityType: 'trust', pspRegistrationNumber: 'IT1234/2010' } as never);
    const url = `/api/payroll/employees/${psp}`;
    const out = await f.call(employeeRoute as Route, 'PATCH', url, psp, { body: { pspEntityType: 'company' } });
    expect(out.statusCode, JSON.stringify(out.body)).toBe(422);
    expect(JSON.stringify(out.body)).toContain('PSP_REGISTRATION_NOT_FOR_ENTITY');
    expect(JSON.stringify(out.body)).toContain('not a company registration number');
    expect((await pool.query('SELECT psp_entity_type, psp_registration_number FROM payroll_employees WHERE id = $1', [psp])).rows[0])
      .toEqual({ psp_entity_type: 'trust', psp_registration_number: 'IT1234/2010' });
    const ok = await f.call(employeeRoute as Route, 'PATCH', url, psp, { body: { pspEntityType: 'company', pspRegistrationNumber: '2015/123456/07' } });
    expect(ok.statusCode, JSON.stringify(ok.body)).toBe(200);
    expect((await pool.query('SELECT psp_entity_type, psp_registration_number FROM payroll_employees WHERE id = $1', [psp])).rows[0])
      .toEqual({ psp_entity_type: 'company', psp_registration_number: '2015/123456/07' });
  });

  it('L-a: moving company -> trust with a stored company number is refused (422, named), nothing written; with a trust number it saves', async () => {
    const f = await seedEmployee(pool, fixtures, 'psph la', 20_000);
    const psp = await addEmployee(pool, f, 'psph-la2', 40_000);
    await updatePayrollEmployee(psp, f.company, { taxStatus: 'personal_service_provider', pspEntityType: 'company', pspRegistrationNumber: '2015/123456/07' } as never);
    const url = `/api/payroll/employees/${psp}`;
    const out = await f.call(employeeRoute as Route, 'PATCH', url, psp, { body: { pspEntityType: 'trust' } });
    expect(out.statusCode, JSON.stringify(out.body)).toBe(422);
    expect(JSON.stringify(out.body)).toContain('PSP_REGISTRATION_NOT_FOR_ENTITY');
    expect(JSON.stringify(out.body)).toContain('not a trust registration number');
    expect((await pool.query('SELECT psp_entity_type, psp_registration_number FROM payroll_employees WHERE id = $1', [psp])).rows[0])
      .toEqual({ psp_entity_type: 'company', psp_registration_number: '2015/123456/07' });
    const ok = await f.call(employeeRoute as Route, 'PATCH', url, psp, { body: { pspEntityType: 'trust', pspRegistrationNumber: 'IT1234/2010' } });
    expect(ok.statusCode, JSON.stringify(ok.body)).toBe(200);
  });

  it('a field-injection value and a check digit that fails modulus 10 are refused (400, nothing written)', async () => {
    const f = await seedEmployee(pool, fixtures, 'psph inject', 20_000);
    const psp = await addEmployee(pool, f, 'psph-inj', 40_000);
    await updatePayrollEmployee(psp, f.company, { taxStatus: 'personal_service_provider', pspEntityType: 'company' });
    const url = `/api/payroll/employees/${psp}`;
    for (const body of [{ pspEntityName: 'Acme"\r\n3020,"N' }, { pspEntityName: 'Acme\u0007' }, { pspTaxReference: '9012345678' }]) {
      const out = await f.call(employeeRoute as Route, 'PATCH', url, psp, { body });
      expect(out.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(await row(psp)).toMatchObject({ psp_entity_name: null, psp_tax_reference: null });
  });

  it('each moved particular is in the change log with who moved it, in the write\'s transaction, and so is the clear off PSP', async () => {
    const f = await seedEmployee(pool, fixtures, 'psph audit', 20_000);
    const psp = await addEmployee(pool, f, 'psph-aud', 40_000);
    await updatePayrollEmployee(psp, f.company, { taxStatus: 'personal_service_provider', pspEntityType: 'company' });
    const url = `/api/payroll/employees/${psp}`;
    expect((await f.call(employeeRoute as Route, 'PATCH', url, psp, { body: GOOD })).statusCode).toBe(200);
    expect((await f.call(employeeRoute as Route, 'PATCH', url, psp, { body: { pspEntityName: 'Acme Two (Pty) Ltd' } })).statusCode).toBe(200);
    expect((await f.call(employeeRoute as Route, 'PATCH', url, psp, { body: { taxStatus: 'employee' } })).statusCode).toBe(200);
    expect(await history(psp)).toEqual([
      { field_name: 'psp_entity_name', old_value: null, new_value: GOOD.pspEntityName },
      { field_name: 'psp_registration_number', old_value: null, new_value: GOOD.pspRegistrationNumber },
      { field_name: 'psp_tax_reference', old_value: null, new_value: GOOD.pspTaxReference },
      { field_name: 'psp_entity_name', old_value: GOOD.pspEntityName, new_value: 'Acme Two (Pty) Ltd' },
      { field_name: 'psp_entity_name', old_value: 'Acme Two (Pty) Ltd', new_value: null },
      { field_name: 'psp_registration_number', old_value: GOOD.pspRegistrationNumber, new_value: null },
      { field_name: 'psp_tax_reference', old_value: GOOD.pspTaxReference, new_value: null },
    ]);
    const who = (await pool.query(`SELECT DISTINCT changed_by FROM payroll_employee_history WHERE employee_id = $1 AND field_name = 'psp_tax_reference'`, [psp])).rows;
    expect(who).toEqual([{ changed_by: f.admin }]);
  });

  it('a role that may not change priced terms may not move the particulars (403, nothing written); resending the stored value is fine', async () => {
    const f = await seedEmployee(pool, fixtures, 'psph manager', 20_000);
    const psp = await addEmployee(pool, f, 'psph-mgr', 40_000);
    await updatePayrollEmployee(psp, f.company, { taxStatus: 'personal_service_provider', pspEntityType: 'company', ...GOOD } as never);
    const manager = crypto.randomUUID();
    managers.push(manager);
    await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'accountant',true)", [manager, `${manager}@test.local`]);
    await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'manager')", [f.company, manager]);
    const token = await new SignJWT({ sub: manager, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
    const asManager = routeCaller({ [manager]: token }, { user: manager, company: f.company });
    const url = `/api/payroll/employees/${psp}`;
    for (const body of [{ pspEntityName: 'Hijack (Pty) Ltd' }, { pspTaxReference: '9000000001' }, { pspRegistrationNumber: '' }]) {
      const out = await asManager(employeeRoute as Route, 'PATCH', url, psp, { body });
      expect(out.statusCode, JSON.stringify(body)).toBe(403);
    }
    expect(await row(psp)).toMatchObject({ psp_entity_name: GOOD.pspEntityName, psp_registration_number: GOOD.pspRegistrationNumber,
      psp_tax_reference: GOOD.pspTaxReference });
    const same = await asManager(employeeRoute as Route, 'PATCH', url, psp, { body: { ...GOOD, occupation: 'Consultant' } });
    expect(same.statusCode, JSON.stringify(same.body)).toBe(200);
  });

  it('a Login-as session may not move the particulars (403, no change); another field still saves', async () => {
    const f = await seedEmployee(pool, fixtures, 'psph login-as', 20_000);
    const psp = await addEmployee(pool, f, 'psph-la', 40_000);
    await updatePayrollEmployee(psp, f.company, { taxStatus: 'personal_service_provider', pspEntityType: 'trust' });
    const asLoginAs = routeCaller({ as: await impersonationToken(pool, f.admin, f.approver) }, { user: 'as', company: f.company });
    const url = `/api/payroll/employees/${psp}`;
    const out = await asLoginAs(employeeRoute as Route, 'PATCH', url, psp, { body: { pspEntityName: 'Acme Trust' } });
    expect(out.statusCode).toBe(403);
    expect(JSON.stringify(out.body)).toContain('IMPERSONATION_FORBIDDEN');
    expect((await row(psp)).psp_entity_name).toBeNull();
    const other = await asLoginAs(employeeRoute as Route, 'PATCH', url, psp, { body: { occupation: 'Consultant' } });
    expect(other.statusCode).toBe(200);
  });
});
