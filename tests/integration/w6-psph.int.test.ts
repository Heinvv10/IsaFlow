/**
 * Wave 6 PSP-H on real Postgres (migration 1015): a PSP's entity particulars. The CHECKs (only a PSP holds them, the 9-prefixed
 * tax reference, the lengths), the PATCH route for two tenants (judged, cleared on moving off PSP, refused for Login-as).
 * Disposable DB only.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
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
afterAll(async () => {
  try {
    await pool.query('DELETE FROM impersonation_sessions WHERE actor_user_id = ANY($1)', [fixtures.map((f) => f.approver)]);
    await cleanSeveranceFixtures(pool, fixtures);
  } finally { await pool.end(); }
});

const code = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return (e as { code?: string }).code ?? String(e); } };
const row = async (id: string) => (await pool.query(
  'SELECT tax_status, psp_entity_name, psp_registration_number, psp_tax_reference FROM payroll_employees WHERE id = $1', [id])).rows[0];
const GOOD = { pspEntityName: 'Acme Consulting (Pty) Ltd', pspRegistrationNumber: '2015/123456/07', pspTaxReference: '9012345678' };

describe('1015: the CHECKs', () => {
  it('only a PSP holds particulars; the tax reference is 10 digits starting with 9; names are 1-120, numbers 1-30', async () => {
    const f = await seedEmployee(pool, fixtures, 'psph checks', 20_000);
    const set = (status: string, entity: string | null, name: string | null, reg: string | null, tax: string | null) => pool.query(
      `UPDATE payroll_employees SET tax_status = $2, psp_entity_type = $3, psp_entity_name = $4, psp_registration_number = $5, psp_tax_reference = $6
        WHERE id = $1`, [f.employee, status, entity, name, reg, tax]);
    expect(await code(set('employee', null, 'Acme', null, null))).toBe('23514');
    expect(await code(set('personal_service_provider', 'company', 'Acme', '2015/123456/07', '9012345678'))).toBeNull();
    expect(await code(set('personal_service_provider', 'company', 'Acme', null, '0123456789'))).toBe('23514');
    expect(await code(set('personal_service_provider', 'company', ' ', null, null))).toBe('23514');
    expect(await code(set('personal_service_provider', 'company', 'x'.repeat(121), null, null))).toBe('23514');
    expect(await code(set('personal_service_provider', 'trust', 'Acme Trust', 'x'.repeat(31), null))).toBe('23514');
    expect(await code(set('employee', null, null, null, null))).toBeNull();
  });
});

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
