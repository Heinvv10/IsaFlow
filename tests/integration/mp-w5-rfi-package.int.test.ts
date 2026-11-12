/**
 * Wave 5 RF round 1: a pay-package apply writes plain amounts, so it must not silently replace an RF row. A pre-RF employer
 * fund row kept as cash (employer_fund_as_cash, migration 975) would become a non-cash deemed contribution, and a
 * percent_of_rfi row would freeze at a fixed amount. Both are refused (400) with the remedy, and nothing is written; a plain
 * 3817 row is replaced as any recurring row is.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { applyPackageToEmployee } from '@/modules/accounting/services/payroll/payPackageService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const company = crypto.randomUUID();
const user = crypto.randomUUID();
const pkg = crypto.randomUUID();
const er = crypto.randomUUID();
const emp: Record<string, string> = {};

async function employee(key: string, amount: number, pct: number | null, asCash: boolean) {
  emp[key] = crypto.randomUUID();
  await pool.query(
    `INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,start_date,status,medical_aid_main_member)
     VALUES($1,$2,$3,'Rf','Pkg','2020-01-01','active',false)`, [emp[key], company, `RFP-${key}`]);
  await pool.query(
    `INSERT INTO payroll_employee_components(employee_id,component_id,amount,effective_from,is_recurring,supersede_inferred,percent_of_rfi,employer_fund_as_cash)
     VALUES($1,$2,$3,'2026-01-01',true,FALSE,$4,$5)`, [emp[key], er, amount, pct, asCash]);
}
const rows = async (key: string) => (await pool.query(
  `SELECT amount::float8 AS amount, percent_of_rfi::float8 AS pct, employer_fund_as_cash AS cash, to_char(effective_to,'YYYY-MM-DD') AS t
     FROM payroll_employee_components WHERE employee_id=$1 ORDER BY effective_from`, [emp[key]])).rows;

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'RF package']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query("INSERT INTO payroll_components(id,company_id,name,sars_source_code,component_type) VALUES($1,$2,'Employer pension','3817','earning')", [er, company]);
  await pool.query("INSERT INTO pay_packages(id,company_id,code,name) VALUES($1,$2,'RF-PKG','RF package')", [pkg, company]);
  await pool.query('INSERT INTO pay_package_components(package_id,component_id,amount,is_recurring) VALUES($1,$2,1000,true)', [pkg, er]);
  await employee('cash', 1500, null, true);
  await employee('pct', 0, 0.075, false);
  await employee('plain', 1500, null, false);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM audit_log WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM payroll_employee_components WHERE employee_id IN (SELECT id FROM payroll_employees WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM pay_package_components WHERE package_id=$1', [pkg]);
    await pool.query('DELETE FROM pay_packages WHERE id=$1', [pkg]);
    await pool.query('DELETE FROM payroll_components WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM payroll_employees WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

describe('a package apply over an RF row', () => {
  it('a pre-RF row kept as cash: refused with the end-and-reassign remedy, nothing written', async () => {
    const before = await rows('cash');
    await expect(applyPackageToEmployee(company, pkg, emp.cash!, '2026-06-01', user)).rejects.toThrow(/kept as cash from before RF.*End that assignment/);
    expect(await rows('cash')).toEqual(before);
  });
  it('a percent_of_rfi row: refused, naming the percentage, nothing written', async () => {
    const before = await rows('pct');
    await expect(applyPackageToEmployee(company, pkg, emp.pct!, '2026-06-01', user)).rejects.toThrow(/7\.5% of retirement-funding income.*fixed amount/);
    expect(await rows('pct')).toEqual(before);
  });
  it('a plain 3817 row is replaced as any recurring row', async () => {
    await applyPackageToEmployee(company, pkg, emp.plain!, '2026-06-01', user);
    expect(await rows('plain')).toEqual([
      { amount: 1500, pct: null, cash: false, t: '2026-05-31' },
      { amount: 1000, pct: null, cash: false, t: null },
    ]);
  });
});
