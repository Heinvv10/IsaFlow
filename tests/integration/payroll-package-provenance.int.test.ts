/**
 * Who wrote a once-off a package apply would cancel, by provenance (the creation audit entry), not by shape: only a
 * `package_assign` entry carrying this package's id makes a row the package's own. A row with no entry (written before
 * origins were recorded) is refused, never cut; when it matches the package line the message says it may be the package's
 * own and offers only remedies a test follows to success (end-then-apply only where End would work).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { applyPackageToEmployee } from '@/modules/accounting/services/payroll/payPackageService';
import { withTransaction } from '@/lib/neon';
import { auditComponentChange } from '@/modules/accounting/services/payroll/payrollComponentAudit';
import { assignComponentToEmployee, endEmployeeComponent } from '@/modules/accounting/services/payroll/payrollEmployeeComponentService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const company = crypto.randomUUID();
const user = crypto.randomUUID();
const pkg = crypto.randomUUID();
const pkg2 = crypto.randomUUID();
const actor = { userId: user, channel: 'service' as const };
// Fixed ids: package lines are applied in component_id order, and these tests assume the salary is processed first.
const comp = { salary: 'aaaaaaaa-0000-4000-8000-0000000000d2', bonus: 'bbbbbbbb-0000-4000-8000-0000000000d2' };
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
  await pool.query("INSERT INTO pay_packages(id,company_id,code,name) VALUES($1,$2,'PH-PKG2','Other package')", [pkg2, company]);
  await pool.query('INSERT INTO pay_package_components(package_id,component_id,amount,is_recurring) VALUES($1,$2,1200,false)', [pkg2, comp.bonus]);
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
    await pool.query('DELETE FROM pay_package_components WHERE package_id = ANY($1::uuid[])', [[pkg, pkg2]]);
    await pool.query('DELETE FROM pay_packages WHERE id = ANY($1::uuid[])', [[pkg, pkg2]]);
    await pool.query('DELETE FROM payroll_components WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM payroll_employees WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});


describe('own by provenance, not by shape', () => {
  it("a hand-entered R1,200 once-off equal to the package's R1,200 line: refused, untouched", async () => {
    await employee('equal');
    await assignComponentToEmployee(company, emp.equal!, comp.bonus, 1200, '2026-05-10', undefined, false, actor); // closed at 31 May, as a package would
    const before = await rows('equal');
    await expect(applyPackageToEmployee(company, pkg, emp.equal!, '2026-05-01', user)).rejects.toThrow(/once-offs? this package did not write/i);
    expect(await rows('equal')).toEqual(before);
  });

  it("another package's once-off is not this package's: refused", async () => {
    await employee('other');
    await applyPackageToEmployee(company, pkg2, emp.other!, '2026-05-01', user);
    await expect(applyPackageToEmployee(company, pkg, emp.other!, '2026-05-01', user)).rejects.toThrow(/once-offs? this package did not write/i);
  });

  it("the same package re-applied after its once-off amount was edited: accepted, one payment", async () => {
    await employee('edited');
    await applyPackageToEmployee(company, pkg, emp.edited!, '2026-05-01', user);
    await pool.query('UPDATE pay_package_components SET amount = 1300 WHERE package_id=$1 AND component_id=$2', [pkg, comp.bonus]);
    try {
      await applyPackageToEmployee(company, pkg, emp.edited!, '2026-05-01', user);
    } finally {
      await pool.query('UPDATE pay_package_components SET amount = 1200 WHERE package_id=$1 AND component_id=$2', [pkg, comp.bonus]);
    }
    const live = (await rows('edited')).filter((r) => r.component_id === comp.bonus && r.t !== null && r.t >= r.f);
    expect(live).toHaveLength(1);
    expect(live[0]!.amount).toBe(1300);
  });

  async function auditedAs(key: string, kind: 'package_assign' | 'assign', extra: { packageId?: string } = {}) {
    const id = String((await pool.query('SELECT id FROM payroll_employee_components WHERE employee_id=$1 ORDER BY effective_from LIMIT 1', [emp[key]])).rows[0]!.id);
    await withTransaction((tx) => auditComponentChange(tx, company, id, null, { from: '2026-05-10', to: '2026-05-31', recurring: false }, kind, actor, extra));
  }

  it("a package_assign entry that records no package is not every package's: another amount is refused", async () => {
    await employee('noPkgId');
    await raw('noPkgId', comp.bonus, 1500, '2026-05-10', '2026-05-31', false);
    await auditedAs('noPkgId', 'package_assign');
    await expect(applyPackageToEmployee(company, pkg, emp.noPkgId!, '2026-05-01', user)).rejects.toThrow(/once-offs? this package did not write/i);
  });

  it("a package_assign entry that records no package is never the package's own, even with its shape: refused", async () => {
    await employee('noPkgIdShape');
    await raw('noPkgIdShape', comp.bonus, 1200, '2026-05-10', '2026-05-31', false);
    await auditedAs('noPkgIdShape', 'package_assign');
    await expect(applyPackageToEmployee(company, pkg, emp.noPkgIdShape!, '2026-05-01', user)).rejects.toThrow(/once-offs? this package did not write/i);
  });

  it('the first audit entry wins: a package_assign entry forged later on a hand-entered once-off changes nothing', async () => {
    await employee('forged');
    await assignComponentToEmployee(company, emp.forged!, comp.bonus, 1500, '2026-05-10', undefined, false, actor);
    await auditedAs('forged', 'package_assign', { packageId: pkg });
    await expect(applyPackageToEmployee(company, pkg, emp.forged!, '2026-05-01', user)).rejects.toThrow(/once-offs? this package did not write/i);
  });

  it('no audit entry and a package amount edited since: refused (fail-safe, shape cannot vouch for it)', async () => {
    await employee('failsafe');
    await raw('failsafe', comp.bonus, 1100, '2026-05-01', '2026-05-31', false);
    await expect(applyPackageToEmployee(company, pkg, emp.failsafe!, '2026-05-01', user)).rejects.toThrow(/once-offs? this package did not write/i);
  });

  const liveBonus = async (key: string) => (await rows(key)).filter((r) => r.component_id === comp.bonus && r.t !== null && r.t >= r.f);

  it('no audit entry, the package\'s shape: refused, untouched, and the message says the origin is unrecorded and gives both ways out', async () => {
    await employee('legacy');
    await raw('legacy', comp.bonus, 1200, '2026-05-10', '2026-05-31', false);
    const before = await rows('legacy');
    const err = await applyPackageToEmployee(company, pkg, emp.legacy!, '2026-05-01', user).then(() => null, (e) => e as Error);
    expect(err!.message).toMatch(/no recorded origin and may be this package's own once-off from an earlier apply/);
    expect(err!.message).not.toMatch(/did not write/);
    expect(err!.message).toMatch(/If it is the package's: end it, then apply from 2026-05-01\. If it was entered by hand: apply from \d{4}-\d\d-\d\d \(applying from \d{4}-\d\d-\d\d when it IS the package's pays its once-off again in \d{4}-\d\d\)/);
    expect(await rows('legacy')).toEqual(before);
  });

  it("the package's own legacy once-off: ending it, then applying from the same date, pays the once-off once", async () => {
    await employee('legacyOwn');
    await raw('legacyOwn', comp.bonus, 1200, '2026-05-10', '2026-05-31', false);
    const id = String((await pool.query('SELECT id FROM payroll_employee_components WHERE employee_id=$1', [emp.legacyOwn])).rows[0]!.id);
    await expect(applyPackageToEmployee(company, pkg, emp.legacyOwn!, '2026-05-01', user)).rejects.toThrow(/no recorded origin/);
    await expect(endEmployeeComponent(company, id, '2026-05-31', actor)).resolves.toBe(true); // no run paid it: cancelled
    await expect(applyPackageToEmployee(company, pkg, emp.legacyOwn!, '2026-05-01', user)).resolves.toBeDefined();
    expect(await liveBonus('legacyOwn')).toHaveLength(1);
  });

  it('a hand-entered row that only looks like the package\'s: the date in the message is accepted', async () => {
    await employee('legacyHand');
    await raw('legacyHand', comp.bonus, 1200, '2026-05-10', '2026-05-31', false);
    const err = await applyPackageToEmployee(company, pkg, emp.legacyHand!, '2026-05-01', user).then(() => null, (e) => e as Error);
    const day = /entered by hand: apply from (\d{4}-\d\d-\d\d)/.exec(err!.message)?.[1];
    expect(day, err!.message).toBeTruthy();
    await expect(applyPackageToEmployee(company, pkg, emp.legacyHand!, day!, user)).resolves.toBeDefined();
  });

  it('applying from the date while the row IS the package\'s pays its once-off in both months (what the message warns of)', async () => {
    await employee('legacyTwice');
    await raw('legacyTwice', comp.bonus, 1200, '2026-05-10', '2026-05-31', false);
    const err = await applyPackageToEmployee(company, pkg, emp.legacyTwice!, '2026-05-01', user).then(() => null, (e) => e as Error);
    const day = /entered by hand: apply from (\d{4}-\d\d-\d\d)/.exec(err!.message)?.[1]!;
    await applyPackageToEmployee(company, pkg, emp.legacyTwice!, day, user);
    expect(await liveBonus('legacyTwice')).toHaveLength(2);
  });

  it('in a paid month only the apply-from route is offered (End refuses a paid once-off), with the warning and the paid remedy; the date works', async () => {
    await employee('legacyPaid');
    const onlyOnce = crypto.randomUUID(); // a once-off-only package: its recurring line would be refused first in a paid month
    await pool.query("INSERT INTO pay_packages(id,company_id,code,name) VALUES($1,$2,'PH-LP','Once only')", [onlyOnce, company]);
    await pool.query('INSERT INTO pay_package_components(package_id,component_id,amount,is_recurring) VALUES($1,$2,1200,false)', [onlyOnce, comp.bonus]);
    await raw('legacyPaid', comp.bonus, 1200, '2026-03-10', '2026-03-31', false);
    const run = crypto.randomUUID();
    await pool.query("INSERT INTO payroll_run_headers(id,company_id,period_month,period_year,status) VALUES($1,$2,3,2026,'approved')", [run, company]);
    await pool.query('UPDATE payroll_run_headers SET calculated_at = now() WHERE id=$1', [run]);
    await pool.query('INSERT INTO payroll_run_lines(run_id,employee_id,gross_pay,taxable_income,paye,net_pay) VALUES($1,$2,100,100,0,100)', [run, emp.legacyPaid]);
    try {
      const err = await applyPackageToEmployee(company, onlyOnce, emp.legacyPaid!, '2026-03-01', user).then(() => null, (e) => e as Error);
      expect(err!.message).toMatch(/2026-03 is already paid.*no recorded origin and may be this package's own.*Apply the package from 2026-04-01 \(applying from 2026-04-01 when it IS the package's pays its once-off again in 2026-04\).*reopen that run and reverse its journal first/);
      expect(err!.message).not.toMatch(/end it, then apply/);
      await expect(applyPackageToEmployee(company, onlyOnce, emp.legacyPaid!, '2026-04-01', user)).resolves.toBeDefined();
    } finally {
      await pool.query('DELETE FROM payroll_run_lines WHERE run_id=$1', [run]);
      await pool.query('DELETE FROM payroll_run_headers WHERE id=$1', [run]);
      await pool.query('DELETE FROM pay_package_components WHERE package_id=$1', [onlyOnce]);
      await pool.query('DELETE FROM pay_packages WHERE id=$1', [onlyOnce]);
    }
  });
});

describe('mixed and cross-component ambiguity, and a paid start month', () => {
  const pkgTwo = crypto.randomUUID(); // once-off lines on the salary (processed first) and the bonus component
  const dateIn = (m: string) => /Apply the package from (\d{4}-\d\d-\d\d)/.exec(m)?.[1];

  beforeAll(async () => {
    await pool.query("INSERT INTO pay_packages(id,company_id,code,name) VALUES($1,$2,'PH-TWO','Two once-offs')", [pkgTwo, company]);
    await pool.query('INSERT INTO pay_package_components(package_id,component_id,amount,is_recurring) VALUES($1,$2,1000,false),($1,$3,1200,false)', [pkgTwo, comp.salary, comp.bonus]);
  });
  afterAll(async () => {
    await pool.query('DELETE FROM pay_package_components WHERE package_id=$1', [pkgTwo]);
    await pool.query('DELETE FROM pay_packages WHERE id=$1', [pkgTwo]);
  });

  it.each([
    ['a recorded hand once-off on the first component, a no-origin package-shaped one on the second', 'mixA', comp.salary, 500, comp.bonus, 1200],
    ['a no-origin package-shaped once-off on the first component, a recorded hand once-off on the second', 'mixB', comp.salary, 1000, comp.bonus, 1500],
  ])('%s: the warning and the ambiguous row are named, only the apply-from date is offered, and it is accepted', async (_name, key, c1, a1, c2, a2) => {
    await employee(key);
    for (const [c, amount] of [[c1, a1], [c2, a2]] as const) {
      const recorded = (c === c1 && key === 'mixA') || (c === c2 && key === 'mixB');
      if (recorded) await assignComponentToEmployee(company, emp[key]!, c, amount, '2026-05-10', undefined, false, actor);
      else await raw(key, c, amount, '2026-05-10', '2026-05-31', false);
    }
    const err = await applyPackageToEmployee(company, pkgTwo, emp[key]!, '2026-05-01', user).then(() => null, (e) => e as Error);
    expect(err!.message).toMatch(/no recorded origin and may be this package's own/);
    expect(err!.message).toMatch(/Others on this package's components were not written by this package/);
    expect(err!.message).not.toMatch(/end it, then apply/);
    const day = dateIn(err!.message);
    expect(day, err!.message).toBe('2026-06-01');
    await expect(applyPackageToEmployee(company, pkgTwo, emp[key]!, day!, user)).resolves.toBeDefined();
  });

  it("the month of the apply date paid company-wide: end-then-apply is not offered, the date is, and it works", async () => {
    await employee('startPaid');
    await employee('startPaidOther');
    await raw('startPaid', comp.bonus, 1200, '2026-07-10', '2026-07-31', false);
    const run = crypto.randomUUID();
    await pool.query("INSERT INTO payroll_run_headers(id,company_id,period_month,period_year,status) VALUES($1,$2,7,2026,'approved')", [run, company]);
    await pool.query('UPDATE payroll_run_headers SET calculated_at = now() WHERE id=$1', [run]);
    await pool.query('INSERT INTO payroll_run_lines(run_id,employee_id,gross_pay,taxable_income,paye,net_pay) VALUES($1,$2,100,100,0,100)', [run, emp.startPaidOther]);
    const onlyOnce = crypto.randomUUID();
    await pool.query("INSERT INTO pay_packages(id,company_id,code,name) VALUES($1,$2,'PH-SP','Once only')", [onlyOnce, company]);
    await pool.query('INSERT INTO pay_package_components(package_id,component_id,amount,is_recurring) VALUES($1,$2,1200,false)', [onlyOnce, comp.bonus]);
    try {
      const err = await applyPackageToEmployee(company, onlyOnce, emp.startPaid!, '2026-07-01', user).then(() => null, (e) => e as Error);
      expect(err!.message).toMatch(/no recorded origin and may be this package's own/);
      expect(err!.message).not.toMatch(/end it, then apply/);
      const day = dateIn(err!.message);
      expect(day, err!.message).toBe('2026-08-01');
      await expect(applyPackageToEmployee(company, onlyOnce, emp.startPaid!, day!, user)).resolves.toBeDefined();
    } finally {
      await pool.query('DELETE FROM payroll_run_lines WHERE run_id=$1', [run]);
      await pool.query('DELETE FROM payroll_run_headers WHERE id=$1', [run]);
      await pool.query('DELETE FROM pay_package_components WHERE package_id=$1', [onlyOnce]);
      await pool.query('DELETE FROM pay_packages WHERE id=$1', [onlyOnce]);
    }
  });
});
