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

describe('a hand-entered once-off the apply would cancel', () => {
  it('a back-pay once-off on the same component: refused, naming it, nothing written', async () => {
    const before = await rows('back');
    await expect(applyPackageToEmployee(company, pkg, emp.back!, '2026-05-01', user))
      .rejects.toThrow(/would cancel.*once-offs? this package did not write.*2026-05-05 to 2026-05-31.*end or move.*later date/i);
    expect(await rows('back')).toEqual(before);
  });

  it('a once-off of another amount on the package once-off component: refused as well', async () => {
    const before = await rows('bonus');
    await expect(applyPackageToEmployee(company, pkg, emp.bonus!, '2026-05-01', user)).rejects.toThrow(/once-offs? this package did not write/i);
    expect(await rows('bonus')).toEqual(before);
  });

  it("a once-off with the package's amount that is not closed at its month end: not the package's own, refused", async () => {
    await expect(applyPackageToEmployee(company, pkg, emp.shape!, '2026-05-01', user)).rejects.toThrow(/once-offs? this package did not write/i);
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

describe('a once-off that is no longer live does not block the apply', () => {
  it('apply 1 Nov, re-apply 15 Nov, End the replacement once-off, re-apply from 1 Nov: accepted', async () => {
    await employee('cycle');
    await applyPackageToEmployee(company, pkg, emp.cycle!, '2026-11-01', user);
    await applyPackageToEmployee(company, pkg, emp.cycle!, '2026-11-15', user);
    const replacement = (await pool.query(
      "SELECT id FROM payroll_employee_components WHERE employee_id=$1 AND component_id=$2 AND effective_from='2026-11-15'", [emp.cycle, comp.bonus])).rows[0]!.id;
    await expect(endEmployeeComponent(company, String(replacement), '2026-11-20', actor)).resolves.toBe(true); // voids it: no run paid it
    await expect(applyPackageToEmployee(company, pkg, emp.cycle!, '2026-11-01', user)).resolves.toMatchObject({ inserted: 2 });
  });
});

describe('a hand-entered once-off in a paid month gets the paid refusal, not the generic one', () => {
  it('back-pay 5-31 May with May approved: the paid-month text and remedy', async () => {
    await employee('paidBack');
    await raw('paidBack', comp.salary, 777, '2026-05-05', '2026-05-31', false);
    const run = crypto.randomUUID();
    await pool.query("INSERT INTO payroll_run_headers(id,company_id,period_month,period_year,status) VALUES($1,$2,5,2026,'approved')", [run, company]);
    await pool.query('INSERT INTO payroll_run_lines(run_id,employee_id,gross_pay,taxable_income,paye,net_pay) VALUES($1,$2,777,777,0,777)', [run, emp.paidBack]);
    const before = await rows('paidBack');
    await expect(applyPackageToEmployee(company, pkg, emp.paidBack!, '2026-05-01', user)).rejects.toThrow(/2026-05 is already paid \(approved run\).*did not write.*Apply the package from 2026-06-01; or, to keep this date, reopen that run and reverse its journal first/);
    expect(await rows('paidBack')).toEqual(before);
    // The date it names is accepted.
    await expect(applyPackageToEmployee(company, pkg, emp.paidBack!, '2026-06-01', user)).resolves.toBeDefined();
    await pool.query('DELETE FROM payroll_run_lines WHERE run_id=$1', [run]);
    await pool.query('DELETE FROM payroll_run_headers WHERE id=$1', [run]);
  });
});

describe('a hand-entered once-off that nobody pays does not block the apply either', () => {
  it('one that was cancelled (End voids it): accepted', async () => {
    await employee('voidedHand');
    await assignComponentToEmployee(company, emp.voidedHand!, comp.bonus, 1500, '2026-05-10', undefined, false, actor);
    const id = (await pool.query('SELECT id FROM payroll_employee_components WHERE employee_id=$1', [emp.voidedHand])).rows[0]!.id;
    await expect(endEmployeeComponent(company, String(id), '2026-05-20', actor)).resolves.toBe(true);
    await expect(applyPackageToEmployee(company, pkg, emp.voidedHand!, '2026-05-01', user)).resolves.toBeDefined();
  });

  it('one an earlier apply already replaced (superseded): accepted', async () => {
    await employee('supersededHand');
    await raw('supersededHand', comp.bonus, 1500, '2026-05-10', '2026-05-31', false);
    await pool.query('UPDATE payroll_employee_components SET superseded_at = now() WHERE employee_id=$1', [emp.supersededHand]);
    await expect(applyPackageToEmployee(company, pkg, emp.supersededHand!, '2026-05-01', user)).resolves.toBeDefined();
  });
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

  it("a package_assign entry that records no package, with the package's own shape: accepted", async () => {
    await employee('noPkgIdShape');
    await raw('noPkgIdShape', comp.bonus, 1200, '2026-05-10', '2026-05-31', false);
    await auditedAs('noPkgIdShape', 'package_assign');
    await expect(applyPackageToEmployee(company, pkg, emp.noPkgIdShape!, '2026-05-01', user)).resolves.toBeDefined();
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

  it('a once-off with no audit entry (written before this release) is judged by its shape: the package amount, closed at month end', async () => {
    await employee('legacy');
    await raw('legacy', comp.bonus, 1200, '2026-05-01', '2026-05-31', false);
    await expect(applyPackageToEmployee(company, pkg, emp.legacy!, '2026-05-01', user)).resolves.toBeDefined();
  });
});

describe('the date a paid-month refusal names holds company-wide: following it is accepted', () => {
  const pkgOnce = crypto.randomUUID(); // a package with only a once-off line: its apply lands in one month
  const headers: Record<string, string> = {};

  async function paidMonth(month: number, who: string[]) {
    headers[month] = crypto.randomUUID();
    await pool.query("INSERT INTO payroll_run_headers(id,company_id,period_month,period_year,status) VALUES($1,$2,$3,2026,'approved')", [headers[month], company, month]);
    await pool.query('UPDATE payroll_run_headers SET calculated_at = now() WHERE id=$1', [headers[month]]); // calculated by this release, so it read the last day
    for (const key of who) {
      await pool.query('INSERT INTO payroll_run_lines(run_id,employee_id,gross_pay,taxable_income,paye,net_pay) VALUES($1,$2,100,100,0,100)', [headers[month], emp[key]]);
    }
  }
  const dateIn = (message: string) => /Apply the package from (\d{4}-\d\d-\d\d)/.exec(message)?.[1];
  async function refusedWith(key: string, packageId: string): Promise<string> {
    const err = await applyPackageToEmployee(company, packageId, emp[key]!, '2026-04-01', user).then(() => null, (e) => e as Error);
    expect(err, `${key} is refused`).not.toBeNull();
    return err!.message;
  }

  beforeAll(async () => {
    await pool.query("INSERT INTO pay_packages(id,company_id,code,name) VALUES($1,$2,'PH-ONCE','Once-off only package')", [pkgOnce, company]);
    await pool.query('INSERT INTO pay_package_components(package_id,component_id,amount,is_recurring) VALUES($1,$2,1200,false)', [pkgOnce, comp.bonus]);
    for (const key of ['spans', 'back0', 'back1', 'back2', 'monthEnd', 'midMonth']) await employee(key);
    await raw('spans', comp.bonus, 1500, '2026-04-10', '2026-05-05', false); // read in April only
    await raw('back0', comp.salary, 777, '2026-04-10', '2026-04-30', false);
    await raw('back1', comp.salary, 777, '2026-04-10', '2026-04-30', false);
    await raw('back2', comp.salary, 777, '2026-04-10', '2026-04-30', false);
    await raw('monthEnd', comp.bonus, 1500, '2026-04-10', '2026-04-30', false);
    await raw('midMonth', comp.bonus, 1500, '2026-04-10', '2026-04-20', false);
    await employee('bystander'); // on the June run only
    await employee('bystander2'); // on the May run only
    await paidMonth(4, ['spans', 'back0', 'back1', 'back2', 'monthEnd', 'midMonth']);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM payroll_run_lines WHERE run_id IN (SELECT id FROM payroll_run_headers WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM payroll_run_headers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM pay_package_components WHERE package_id=$1', [pkgOnce]);
    await pool.query('DELETE FROM pay_packages WHERE id=$1', [pkgOnce]);
  });

  it('only April paid, a once-off package, a once-off ending 5 May: the day after (6 May) is named and accepted', async () => {
    const day = dateIn(await refusedWith('spans', pkgOnce));
    expect(day).toBe('2026-05-06');
    await expect(applyPackageToEmployee(company, pkgOnce, emp.spans!, day!, user)).resolves.toBeDefined();
  });

  it('only April paid, a package with a recurring line: the month after the latest paid month (1 May)', async () => {
    const day = dateIn(await refusedWith('back0', pkg));
    expect(day).toBe('2026-05-01');
    await expect(applyPackageToEmployee(company, pkg, emp.back0!, day!, user)).resolves.toBeDefined();
  });

  it('April and June paid with May open: the recurring package is pointed past the LATER paid month (1 July), not at 1 May', async () => {
    await paidMonth(6, ['bystander']); // June is paid; May is still open
    const day = dateIn(await refusedWith('back2', pkg));
    expect(day).toBe('2026-07-01');
    await expect(applyPackageToEmployee(company, pkg, emp.back2!, day!, user)).resolves.toBeDefined();
  });
  it('May then paid for someone else only: the recurring package is still pointed past the latest paid month (1 July)', async () => {
    await paidMonth(5, ['bystander2']);
    const day = dateIn(await refusedWith('back1', pkg));
    expect(day).toBe('2026-07-01');
    await expect(applyPackageToEmployee(company, pkg, emp.back1!, day!, user)).resolves.toBeDefined();
  });

  it('a once-off ending on the month end, the next months paid company-wide: skipped through them (1 July)', async () => {
    const day = dateIn(await refusedWith('monthEnd', pkgOnce));
    expect(day).toBe('2026-07-01');
    await expect(applyPackageToEmployee(company, pkgOnce, emp.monthEnd!, day!, user)).resolves.toBeDefined();
  });

  it('a once-off ending mid-month in a paid month: skipped through the paid months (1 July)', async () => {
    const day = dateIn(await refusedWith('midMonth', pkgOnce));
    expect(day).toBe('2026-07-01');
    await expect(applyPackageToEmployee(company, pkgOnce, emp.midMonth!, day!, user)).resolves.toBeDefined();
  });

});
