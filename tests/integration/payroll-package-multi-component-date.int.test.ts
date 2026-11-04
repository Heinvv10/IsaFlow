/**
 * The date a package-apply refusal names holds whichever component refuses first. Components are processed in id order
 * (the package lines are read ORDER BY component_id), and the two here have fixed ids, so A is always first:
 *   - A holds a hand once-off in a PAID month (April), B one in open August: the paid-month refusal at A names 2026-09-01;
 *   - A holds one in open May, B one in August, nothing paid: the generic refusal at A names 2026-09-01.
 * Each date is followed and accepted. The once-off queries are also scoped to the company.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { withTransaction } from '@/lib/neon';
import { applyPackageToEmployee } from '@/modules/accounting/services/payroll/payPackageService';
import { foreignOnceOffsOf, supersedeForPackage } from '@/modules/accounting/services/payroll/payPackageSupersede';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const company = crypto.randomUUID();
const other = crypto.randomUUID();
const user = crypto.randomUUID();
const pkg = crypto.randomUUID();
const A = 'aaaaaaaa-0000-4000-8000-0000000000c1';
const B = 'bbbbbbbb-0000-4000-8000-0000000000c1';
const emp: Record<string, string> = {};

async function employee(key: string) {
  emp[key] = crypto.randomUUID();
  await pool.query(
    `INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,start_date,status,medical_aid_main_member)
     VALUES($1,$2,$3,'Multi','Component','2020-01-01','active',false)`, [emp[key], company, `MC-${key}`]);
}
async function raw(key: string, component: string, amount: number, from: string, to: string | null, recurring = false) {
  await pool.query(
    `INSERT INTO payroll_employee_components(employee_id,component_id,amount,effective_from,effective_to,is_recurring,supersede_inferred)
     VALUES($1,$2,$3,$4::date,$5::date,$6,FALSE)`, [emp[key], component, amount, from, to, recurring]);
}
const dateIn = (message: string) => /pply the package from (\d{4}-\d\d-\d\d)/.exec(message)?.[1];

beforeAll(async () => {
  for (const [id, name] of [[company, 'Multi component date'], [other, 'Multi component date, other tenant']]) await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [id, name]);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  for (const [id, name] of [[A, 'Alpha'], [B, 'Bravo']]) {
    await pool.query("INSERT INTO payroll_components(id,company_id,name,sars_source_code,component_type) VALUES($1,$2,$3,'3605','earning')", [id, company, name]);
  }
  await pool.query("INSERT INTO pay_packages(id,company_id,code,name) VALUES($1,$2,'MC-PKG','Two components')", [pkg, company]);
  await pool.query('INSERT INTO pay_package_components(package_id,component_id,amount,is_recurring) VALUES($1,$2,1200,false),($1,$3,1200,false)', [pkg, B, A]); // inserted B first
  for (const key of ['paidA', 'openA', 'tenant']) await employee(key);
  await raw('paidA', A, 777, '2026-04-10', '2026-04-30');
  await raw('paidA', B, 1500, '2026-08-10', '2026-08-31');
  await raw('openA', A, 777, '2026-05-10', '2026-05-31');
  await raw('openA', B, 1500, '2026-08-10', '2026-08-31');
  await raw('tenant', A, 777, '2026-05-10', '2026-05-31');
  await raw('tenant', B, 3000, '2026-01-01', null, true);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM audit_log WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM payroll_run_lines WHERE run_id IN (SELECT id FROM payroll_run_headers WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM payroll_run_headers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM payroll_employee_components WHERE employee_id IN (SELECT id FROM payroll_employees WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM pay_package_components WHERE package_id=$1', [pkg]);
    await pool.query('DELETE FROM pay_packages WHERE id=$1', [pkg]);
    await pool.query('DELETE FROM payroll_components WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM payroll_employees WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [[company, other]]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

describe('the named date clears every component, whichever refuses first', () => {
  it('the paid-month refusal (April paid at A, an August once-off at B): 2026-09-01, and it is accepted', async () => {
    const run = crypto.randomUUID();
    await pool.query("INSERT INTO payroll_run_headers(id,company_id,period_month,period_year,status) VALUES($1,$2,4,2026,'approved')", [run, company]);
    await pool.query('UPDATE payroll_run_headers SET calculated_at = now() WHERE id=$1', [run]);
    await pool.query('INSERT INTO payroll_run_lines(run_id,employee_id,gross_pay,taxable_income,paye,net_pay) VALUES($1,$2,100,100,0,100)', [run, emp.paidA]);
    try {
      const err = await applyPackageToEmployee(company, pkg, emp.paidA!, '2026-04-01', user).then(() => null, (e) => e as Error);
      expect(err?.message).toMatch(/2026-04 is already paid/);
      const day = dateIn(err!.message);
      expect(day, err!.message).toBe('2026-09-01');
      await expect(applyPackageToEmployee(company, pkg, emp.paidA!, day!, user)).resolves.toBeDefined();
    } finally {
      await pool.query('DELETE FROM payroll_run_lines WHERE run_id=$1', [run]);
      await pool.query('DELETE FROM payroll_run_headers WHERE id=$1', [run]);
    }
  });

  it('the generic refusal (a May once-off at A, an August one at B, nothing paid): 2026-09-01, and it is accepted', async () => {
    const err = await applyPackageToEmployee(company, pkg, emp.openA!, '2026-05-01', user).then(() => null, (e) => e as Error);
    expect(err?.message).toMatch(/would cancel a once-off this package did not write/);
    const day = dateIn(err!.message);
    expect(day, err!.message).toBe('2026-09-01');
    await expect(applyPackageToEmployee(company, pkg, emp.openA!, day!, user)).resolves.toBeDefined();
  });
});

describe("the package's once-off queries are scoped to the company", () => {
  const input = (companyId: string) => ({ companyId, packageId: pkg, employeeId: emp.tenant!, componentId: B, effectiveFrom: '2026-05-01', paid: [], actor: { userId: user, channel: 'service' as const } });

  it("another company's guard finds none of this company's once-offs for the same employee id", async () => {
    expect(await withTransaction((tx) => foreignOnceOffsOf(tx, { companyId: other, packageId: pkg, employeeId: emp.tenant!, effectiveFrom: '2026-05-01' }, [{ component_id: A }]))).toEqual([]);
    expect((await withTransaction((tx) => foreignOnceOffsOf(tx, { companyId: company, packageId: pkg, employeeId: emp.tenant!, effectiveFrom: '2026-05-01' }, [{ component_id: A }]))).length).toBe(1);
  });

  it("another company's apply cuts nothing of this company's recurring row", async () => {
    expect(await withTransaction((tx) => supersedeForPackage(tx, input(other)))).toBe(0);
    const { rows } = await pool.query('SELECT effective_to FROM payroll_employee_components WHERE employee_id=$1 AND component_id=$2', [emp.tenant, B]);
    expect(rows[0]!.effective_to).toBeNull();
  });
});
