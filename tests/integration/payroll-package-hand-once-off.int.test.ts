/**
 * A pay-package apply cuts the recurring rows it overlaps, and the once-off rows IT wrote before (the re-apply case:
 * same component, a once-off closed at its month end, the package line's amount). A once-off somebody entered by hand
 * (a back-pay on Basic Salary) is not the package's to cancel: the apply is refused (400), nothing is written, and the
 * message names the once-offs and says to end or move them, or to apply from a later date.
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
const comp = { salary: crypto.randomUUID(), bonus: crypto.randomUUID() };
const emp: Record<string, string> = {};

async function employee(key: string) {
  emp[key] = crypto.randomUUID();
  await pool.query(
    `INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,start_date,status,medical_aid_main_member)
     VALUES($1,$2,$3,'Pkg','Hand','2020-01-01','active',false)`, [emp[key], company, `PH-${key}`]);
}
async function raw(key: string, component: string, amount: number, from: string, to: string | null, recurring: boolean) {
  await pool.query(
    `INSERT INTO payroll_employee_components(employee_id,component_id,amount,effective_from,effective_to,is_recurring,supersede_inferred)
     VALUES($1,$2,$3,$4::date,$5::date,$6,FALSE)`, [emp[key], component, amount, from, to, recurring]);
}
const rows = async (key: string) => (await pool.query(
  `SELECT component_id, amount::float8 AS amount, to_char(effective_from,'YYYY-MM-DD') AS f, to_char(effective_to,'YYYY-MM-DD') AS t,
          is_recurring AS r, superseded_at IS NOT NULL AS cut
     FROM payroll_employee_components WHERE employee_id=$1 ORDER BY effective_from, amount`, [emp[key]])).rows;

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'Package vs hand-entered once-off']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  for (const [id, name, code] of [[comp.salary, 'Basic salary', '3601'], [comp.bonus, 'Bonus', '3605']]) {
    await pool.query("INSERT INTO payroll_components(id,company_id,name,sars_source_code,component_type) VALUES($1,$2,$3,$4,'earning')", [id, company, name, code]);
  }
  await pool.query("INSERT INTO pay_packages(id,company_id,code,name) VALUES($1,$2,'PH-PKG','Hand once-off package')", [pkg, company]);
  await pool.query(
    'INSERT INTO pay_package_components(package_id,component_id,amount,is_recurring) VALUES($1,$2,3000,true),($1,$3,1200,false)', [pkg, comp.salary, comp.bonus]);
  await employee('back');
  await raw('back', comp.salary, 777, '2026-05-05', '2026-05-31', false);
  await employee('bonus');
  await raw('bonus', comp.bonus, 1500, '2026-05-10', '2026-05-31', false);
  await employee('shape');
  // The package's amount, but not closed at its month end: not the package's own row.
  await raw('shape', comp.bonus, 1200, '2026-05-10', '2026-05-20', false);
  await employee('again');
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

describe('a hand-entered once-off the apply would cancel', () => {
  it('a back-pay once-off on the same component: refused, naming it, nothing written', async () => {
    const before = await rows('back');
    await expect(applyPackageToEmployee(company, pkg, emp.back!, '2026-05-01', user))
      .rejects.toThrow(/would cancel.*hand-entered once-off.*2026-05-05 to 2026-05-31.*end or move.*later date/i);
    expect(await rows('back')).toEqual(before);
  });

  it('a once-off of another amount on the package once-off component: refused as well', async () => {
    const before = await rows('bonus');
    await expect(applyPackageToEmployee(company, pkg, emp.bonus!, '2026-05-01', user)).rejects.toThrow(/hand-entered once-off/i);
    expect(await rows('bonus')).toEqual(before);
  });

  it("a once-off with the package's amount that is not closed at its month end: not the package's own, refused", async () => {
    await expect(applyPackageToEmployee(company, pkg, emp.shape!, '2026-05-01', user)).rejects.toThrow(/hand-entered once-off/i);
  });

  it('applied from after the once-off ends, the apply goes through and leaves it alone', async () => {
    await expect(applyPackageToEmployee(company, pkg, emp.back!, '2026-06-01', user)).resolves.toMatchObject({ inserted: 2 });
    expect((await rows('back')).find((r) => r.amount === 777)).toMatchObject({ f: '2026-05-05', t: '2026-05-31', cut: false });
  });
});

describe("the package's own once-off, applied again", () => {
  it('is cut by the re-apply, so the month pays it once', async () => {
    await applyPackageToEmployee(company, pkg, emp.again!, '2026-05-01', user);
    await applyPackageToEmployee(company, pkg, emp.again!, '2026-05-01', user);
    const bonuses = (await rows('again')).filter((r) => r.component_id === comp.bonus);
    expect(bonuses).toHaveLength(2);
    const live = bonuses.filter((r) => r.t !== null && r.t >= r.f);
    expect(live).toHaveLength(1);
    expect(bonuses.find((r) => r.t! < r.f)).toMatchObject({ cut: true });
  });
});
