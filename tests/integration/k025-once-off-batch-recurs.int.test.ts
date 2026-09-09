/**
 * K-025: a once-off payroll batch (is_recurring = false) posted
 * payroll_employee_components rows with effective_to = NULL, so the amount was
 * picked up again in every later period. postBatch now closes a once-off
 * assignment at the end of the LINE's own effective_from month — the rule
 * assignComponentToEmployee already applies. Recurring batches stay open-ended.
 *
 * Reader under test: payrollComponentService.getEmployeeComponents — the
 * function payrollRunService.calculatePayrollRun calls per employee. The run
 * builds `new Date(period.year, period.month - 1, 28)` in LOCAL time and
 * getEmployeeComponents renders it with toISOString(), so the date actually
 * queried is day 27 in SAST and day 28 on a UTC server. Nothing here depends
 * on which: a once-off row is open for its whole month either way.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  createBatch, addBatchLines, validateBatch, postBatch,
} from '../../src/modules/accounting/services/payroll/payrollBatchService';
import { getEmployeeComponents } from '../../src/modules/accounting/services/payroll/payrollComponentService';
import { applyPackageToEmployee } from '../../src/modules/accounting/services/payroll/payPackageService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const company = crypto.randomUUID();
const otherCompany = crypto.randomUUID();
const user = crypto.randomUUID();
const onceOffEmployee = crypto.randomUUID();
const recurringEmployee = crypto.randomUUID();
const explicitEndEmployee = crypto.randomUUID();
const travelEmployee = crypto.randomUUID();
const monthEndEmployee = crypto.randomUUID();
const backdatedEmployee = crypto.randomUUID();
const forwardDatedEmployee = crypto.randomUUID();
const packageEmployee = crypto.randomUUID();
const payPackage = crypto.randomUUID();
const packageOnceOff = crypto.randomUUID();
const packageRecurring = crypto.randomUUID();
const reapplyEmployee = crypto.randomUUID();
const laterApplyEmployee = crypto.randomUUID();
const boundaryEmployee = crypto.randomUUID();
const futureRowEmployee = crypto.randomUUID();
const otherEmployee = crypto.randomUUID();
const bonusComponent = crypto.randomUUID();
const allowanceComponent = crypto.randomUUID();
const travelTaxable = crypto.randomUUID();
const travelNonTaxable = crypto.randomUUID();
const otherComponent = crypto.randomUUID();
const batchIds: string[] = [];

// Exactly what calculatePayrollRun builds (local-time day 28; see header).
const periodDate = (year: number, month: number) => new Date(year, month - 1, 28);

async function addEmployee(id: string, companyId: string, number: string) {
  await pool.query(
    `INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,start_date,status)
     VALUES($1,$2,$3,'Once','Off','2020-01-01','active')`,
    [id, companyId, number],
  );
}

async function addComponent(id: string, companyId: string, name: string, code: string) {
  await pool.query(
    `INSERT INTO payroll_components(id,company_id,name,sars_source_code,component_type,is_taxable)
     VALUES($1,$2,$3,$4,'earning',true)`,
    [id, companyId, name, code],
  );
}

async function postOne(
  companyId: string,
  input: { batchType: 'component_values' | 'reimbursive_travel'; componentId?: string; isRecurring: boolean; month: number },
  line: Parameters<typeof addBatchLines>[2][number],
) {
  const batch = await createBatch({
    companyId, batchType: input.batchType, componentId: input.componentId,
    description: `K025 ${input.batchType} ${input.isRecurring ? 'recurring' : 'once-off'}`,
    periodYear: 2025, periodMonth: input.month, isRecurring: input.isRecurring, userId: user,
  });
  batchIds.push(batch.id);
  await addBatchLines(companyId, batch.id, [line]);
  const validated = await validateBatch(companyId, batch.id);
  expect(validated.ok).toBe(true);
  await postBatch(companyId, batch.id, user);
  return batch.id;
}

beforeAll(async () => {
  for (const [id, name] of [[company, 'K025 batch fixture'], [otherCompany, 'K025 other tenant']] as const) {
    await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [id, name]);
  }
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await addEmployee(onceOffEmployee, company, 'E-K025-1');
  await addEmployee(recurringEmployee, company, 'E-K025-2');
  await addEmployee(explicitEndEmployee, company, 'E-K025-3');
  await addEmployee(travelEmployee, company, 'E-K025-4');
  await addEmployee(monthEndEmployee, company, 'E-K025-5');
  await addEmployee(backdatedEmployee, company, 'E-K025-7');
  await addEmployee(forwardDatedEmployee, company, 'E-K025-8');
  await addEmployee(packageEmployee, company, 'E-K025-9');
  await addEmployee(reapplyEmployee, company, 'E-K025-10');
  await addEmployee(laterApplyEmployee, company, 'E-K025-11');
  await addEmployee(boundaryEmployee, company, 'E-K025-12');
  await addEmployee(futureRowEmployee, company, 'E-K025-13');
  await addEmployee(otherEmployee, otherCompany, 'E-K025-6');
  await addComponent(bonusComponent, company, 'March bonus', '3605');
  await addComponent(allowanceComponent, company, 'Standing allowance', '3713');
  await addComponent(travelTaxable, company, 'Travel taxable', '3702');
  await addComponent(travelNonTaxable, company, 'Travel non-taxable', '3703');
  await addComponent(otherComponent, otherCompany, 'Other tenant bonus', '3605');
  await addComponent(packageOnceOff, company, 'Sign-on bonus', '3605');
  await addComponent(packageRecurring, company, 'Package basic', '3601');
  await pool.query(
    "INSERT INTO pay_packages(id,company_id,code,name) VALUES($1,$2,'K025-PKG','K025 package')",
    [payPackage, company],
  );
  await pool.query(
    `INSERT INTO pay_package_components(package_id,component_id,amount,is_recurring)
     VALUES($1,$2,12000,false),($1,$3,30000,true)`,
    [payPackage, packageOnceOff, packageRecurring],
  );

  // Exactly what the UI creates: isRecurring off, line carries NO effectiveTo.
  await postOne(company, { batchType: 'component_values', componentId: bonusComponent, isRecurring: false, month: 3 },
    { employeeId: onceOffEmployee, value: 25000, effectiveFrom: new Date('2025-03-01') });
  // A deliberately recurring batch must stay open-ended.
  await postOne(company, { batchType: 'component_values', componentId: allowanceComponent, isRecurring: true, month: 3 },
    { employeeId: recurringEmployee, value: 1500, effectiveFrom: new Date('2025-03-01') });
  // An explicit effectiveTo must be preserved, not overwritten by the period end.
  await postOne(company, { batchType: 'component_values', componentId: bonusComponent, isRecurring: false, month: 3 },
    { employeeId: explicitEndEmployee, value: 900, effectiveFrom: new Date('2025-03-01'), effectiveTo: new Date('2025-05-31') });
  // Reimbursive travel splits into a 3702 and a 3703 row; both must close.
  await postOne(company, { batchType: 'reimbursive_travel', isRecurring: false, month: 3 },
    { employeeId: travelEmployee, km: 1000, ratePerKm: 5, taxablePortion: 1000, nonTaxablePortion: 4000, effectiveFrom: new Date('2025-03-01') });
  // R-006: the UI defaults effectiveFrom to the LAST day of the batch period.
  await postOne(company, { batchType: 'component_values', componentId: bonusComponent, isRecurring: false, month: 3 },
    { employeeId: monthEndEmployee, value: 700, effectiveFrom: new Date('2025-03-31') });
  // A line dated BEFORE the batch period: closing at the batch period end would
  // leave it paying January, February and March.
  await postOne(company, { batchType: 'component_values', componentId: bonusComponent, isRecurring: false, month: 3 },
    { employeeId: backdatedEmployee, value: 600, effectiveFrom: new Date('2025-01-10') });
  // A line dated AFTER the batch period: clamping to the period end would store
  // a one-day window the run never evaluates, so it would never be paid.
  await postOne(company, { batchType: 'component_values', componentId: bonusComponent, isRecurring: false, month: 3 },
    { employeeId: forwardDatedEmployee, value: 800, effectiveFrom: new Date('2025-06-15') });
  // The third writer to payroll_employee_components: a package whose row is
  // flagged once-off must not become an open-ended assignment either.
  await applyPackageToEmployee(company, payPackage, packageEmployee, '2025-03-01', user);
  // Re-applying the same package in the same month — the obvious way a user
  // corrects a mistyped effective date. The second apply must supersede the
  // first, including the once-off row, which is inserted already closed.
  await applyPackageToEmployee(company, payPackage, reapplyEmployee, '2025-03-01', user);
  await applyPackageToEmployee(company, payPackage, reapplyEmployee, '2025-03-15', user);
  // Re-applying in a LATER month must leave the earlier once-off row intact:
  // it was already paid and closed inside its own month.
  await applyPackageToEmployee(company, payPackage, laterApplyEmployee, '2025-03-01', user);
  await applyPackageToEmployee(company, payPackage, laterApplyEmployee, '2025-05-01', user);
  // A hand-made assignment closed exactly the day BEFORE the apply must survive
  // untouched — the supersede predicate must not reach one place too far.
  await pool.query(
    `INSERT INTO payroll_employee_components(employee_id,component_id,amount,effective_from,effective_to,is_recurring)
     VALUES($1,$2,777,'2025-01-01','2025-02-28',true)`,
    [boundaryEmployee, packageRecurring],
  );
  await applyPackageToEmployee(company, payPackage, boundaryEmployee, '2025-03-01', user);
  // A row entirely in the FUTURE is cancelled by an earlier apply, not left to
  // pay alongside it. Silent cancellation is what the warning covers.
  await pool.query(
    `INSERT INTO payroll_employee_components(employee_id,component_id,amount,effective_from,effective_to,is_recurring)
     VALUES($1,$2,999,'2025-06-01','2025-06-30',false)`,
    [futureRowEmployee, packageRecurring],
  );
  await applyPackageToEmployee(company, payPackage, futureRowEmployee, '2025-03-15', user);
  // Second tenant, same shape — must be untouched by any of the above.
  await postOne(otherCompany, { batchType: 'component_values', componentId: otherComponent, isRecurring: false, month: 3 },
    { employeeId: otherEmployee, value: 400, effectiveFrom: new Date('2025-03-01') });
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM payroll_employee_components WHERE employee_id = ANY($1::uuid[])',
      [[onceOffEmployee, recurringEmployee, explicitEndEmployee, travelEmployee, monthEndEmployee,
        backdatedEmployee, forwardDatedEmployee, packageEmployee, reapplyEmployee,
        laterApplyEmployee, boundaryEmployee, futureRowEmployee, otherEmployee]]);
    await pool.query('DELETE FROM payroll_batch_lines WHERE batch_id = ANY($1::uuid[])', [batchIds]);
    await pool.query('DELETE FROM pay_package_components WHERE package_id=$1', [payPackage]);
    await pool.query('DELETE FROM pay_packages WHERE id=$1', [payPackage]);
    for (const id of [company, otherCompany]) {
      await pool.query('DELETE FROM payroll_batches WHERE company_id=$1', [id]);
      await pool.query('DELETE FROM payroll_components WHERE company_id=$1', [id]);
      await pool.query('DELETE FROM payroll_employees WHERE company_id=$1', [id]);
      await pool.query('DELETE FROM companies WHERE id=$1', [id]);
    }
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

async function assignments(employeeId: string) {
  const { rows } = await pool.query(
    `SELECT amount, effective_from, effective_to, is_recurring, component_id
       FROM payroll_employee_components WHERE employee_id=$1 ORDER BY amount`,
    [employeeId],
  );
  return rows;
}

describe('once-off component_values batch', () => {
  it('is stored closed at the end of its own batch period', async () => {
    const rows = await assignments(onceOffEmployee);
    expect(rows).toHaveLength(1);
    expect(rows[0].is_recurring).toBe(false);
    expect(rows[0].effective_to).not.toBeNull();
    expect(new Date(rows[0].effective_to).toISOString().slice(0, 10)).toBe('2025-03-31');
  });

  it('the bonus IS paid in the batch period it was captured for (March 2025)', async () => {
    const march = await getEmployeeComponents(onceOffEmployee, company, periodDate(2025, 3));
    expect(march.map(c => c.amount)).toEqual([25000]);
  });

  it('is NOT paid again in April 2025', async () => {
    expect(await getEmployeeComponents(onceOffEmployee, company, periodDate(2025, 4))).toEqual([]);
  });

  it('and not in the following tax year either', async () => {
    expect(await getEmployeeComponents(onceOffEmployee, company, periodDate(2026, 6))).toEqual([]);
  });
});

describe('adjacent cases', () => {
  it('a recurring batch is still open-ended and still pays in later periods', async () => {
    const rows = await assignments(recurringEmployee);
    expect(rows).toHaveLength(1);
    expect(rows[0].is_recurring).toBe(true);
    expect(rows[0].effective_to).toBeNull();
    const later = await getEmployeeComponents(recurringEmployee, company, periodDate(2026, 6));
    expect(later.map(c => c.amount)).toEqual([1500]);
  });

  it('an explicit line effective_to is preserved, not overwritten by the period end', async () => {
    const rows = await assignments(explicitEndEmployee);
    expect(new Date(rows[0].effective_to).toISOString().slice(0, 10)).toBe('2025-05-31');
    expect(await getEmployeeComponents(explicitEndEmployee, company, periodDate(2025, 5))).toHaveLength(1);
    expect(await getEmployeeComponents(explicitEndEmployee, company, periodDate(2025, 6))).toEqual([]);
  });

  it('both reimbursive-travel rows (3702 and 3703) close at the period end', async () => {
    const rows = await assignments(travelEmployee);
    expect(rows).toHaveLength(2);
    expect(rows.map(r => Number(r.amount)).sort((a, b) => a - b)).toEqual([1000, 4000]);
    for (const row of rows) {
      expect(new Date(row.effective_to).toISOString().slice(0, 10)).toBe('2025-03-31');
    }
    expect(await getEmployeeComponents(travelEmployee, company, periodDate(2025, 3))).toHaveLength(2);
    expect(await getEmployeeComponents(travelEmployee, company, periodDate(2025, 4))).toEqual([]);
  });

  it('a backdated line pays once in its own month, not every month to the period end', async () => {
    const rows = await assignments(backdatedEmployee);
    expect(new Date(rows[0].effective_to).toISOString().slice(0, 10)).toBe('2025-01-31');
    expect((await getEmployeeComponents(backdatedEmployee, company, periodDate(2025, 1))).map(c => c.amount)).toEqual([600]);
    for (const month of [2, 3, 4]) {
      expect(await getEmployeeComponents(backdatedEmployee, company, periodDate(2025, month))).toEqual([]);
    }
  });

  it('a line dated after the batch period is still paid, once, in its own month', async () => {
    const rows = await assignments(forwardDatedEmployee);
    expect(new Date(rows[0].effective_to).toISOString().slice(0, 10)).toBe('2025-06-30');
    expect(new Date(rows[0].effective_to) > new Date(rows[0].effective_from)).toBe(true);
    expect((await getEmployeeComponents(forwardDatedEmployee, company, periodDate(2025, 6))).map(c => c.amount)).toEqual([800]);
    for (const [y, m] of [[2025, 3], [2025, 7], [2026, 1]] as const) {
      expect(await getEmployeeComponents(forwardDatedEmployee, company, periodDate(y, m))).toEqual([]);
    }
  });

  it('the second tenant is untouched and its own once-off batch closes independently', async () => {
    const rows = await assignments(otherEmployee);
    expect(rows).toHaveLength(1);
    expect(new Date(rows[0].effective_to).toISOString().slice(0, 10)).toBe('2025-03-31');
    expect(await getEmployeeComponents(otherEmployee, otherCompany, periodDate(2025, 3))).toHaveLength(1);
    // Cross-tenant read returns nothing.
    expect(await getEmployeeComponents(otherEmployee, company, periodDate(2025, 3))).toEqual([]);
    expect(await getEmployeeComponents(onceOffEmployee, otherCompany, periodDate(2025, 3))).toEqual([]);
  });
});

describe('pay packages use the same close rule', () => {
  it('a once-off package row closes at month end, a recurring one stays open', async () => {
    const rows = await assignments(packageEmployee);
    expect(rows).toHaveLength(2);
    const onceOff = rows.find(r => String(r.component_id) === packageOnceOff);
    const recurring = rows.find(r => String(r.component_id) === packageRecurring);
    expect(new Date(onceOff!.effective_to).toISOString().slice(0, 10)).toBe('2025-03-31');
    expect(recurring!.effective_to).toBeNull();
  });

  it('the once-off package amount is paid in March and never again', async () => {
    const march = await getEmployeeComponents(packageEmployee, company, periodDate(2025, 3));
    expect(march.map(c => c.amount).sort((a, b) => a - b)).toEqual([12000, 30000]);
    const april = await getEmployeeComponents(packageEmployee, company, periodDate(2025, 4));
    expect(april.map(c => c.amount)).toEqual([30000]);
    const later = await getEmployeeComponents(packageEmployee, company, periodDate(2026, 6));
    expect(later.map(c => c.amount)).toEqual([30000]);
  });
});

describe('re-applying a pay package', () => {
  it('in the same month supersedes the first apply instead of paying the once-off twice', async () => {
    const march = await getEmployeeComponents(reapplyEmployee, company, periodDate(2025, 3));
    // The package defines R12 000 once-off + R30 000 recurring. Two applies in
    // one month must still pay exactly that, not double the once-off.
    expect(march.map(c => c.amount).sort((a, b) => a - b)).toEqual([12000, 30000]);
    // Both rows from the first apply — the recurring one AND the already-closed
    // once-off one — are end-dated the day before the second apply.
    const rows = await assignments(reapplyEmployee);
    expect(rows).toHaveLength(4);
    const superseded = rows.filter(r => new Date(r.effective_to).toISOString().slice(0, 10) === '2025-03-14');
    expect(superseded.map(r => Number(r.amount)).sort((a, b) => a - b)).toEqual([12000, 30000]);
  });

  it('in a later month leaves the earlier once-off row intact and pays it once', async () => {
    const march = await getEmployeeComponents(laterApplyEmployee, company, periodDate(2025, 3));
    expect(march.map(c => c.amount).sort((a, b) => a - b)).toEqual([12000, 30000]);
    // April: the March once-off is closed, the recurring row runs on.
    expect((await getEmployeeComponents(laterApplyEmployee, company, periodDate(2025, 4))).map(c => c.amount))
      .toEqual([30000]);
    // May: the second apply's once-off is paid, exactly once.
    expect((await getEmployeeComponents(laterApplyEmployee, company, periodDate(2025, 5))).map(c => c.amount).sort((a, b) => a - b))
      .toEqual([12000, 30000]);
    expect((await getEmployeeComponents(laterApplyEmployee, company, periodDate(2025, 6))).map(c => c.amount))
      .toEqual([30000]);
  });
});

describe('supersede boundaries', () => {
  it('leaves a row that closed the day before the apply exactly as it was', async () => {
    const rows = await assignments(boundaryEmployee);
    const preserved = rows.find(r => Number(r.amount) === 777);
    expect(preserved).toBeDefined();
    expect(new Date(preserved!.effective_to).toISOString().slice(0, 10)).toBe('2025-02-28');
    // February still pays it; March pays only the package.
    expect((await getEmployeeComponents(boundaryEmployee, company, periodDate(2025, 2))).map(c => c.amount)).toEqual([777]);
    expect((await getEmployeeComponents(boundaryEmployee, company, periodDate(2025, 3))).map(c => c.amount).sort((a, b) => a - b))
      .toEqual([12000, 30000]);
  });

  it('cancels a future-dated row rather than paying it alongside the new one', async () => {
    const rows = await assignments(futureRowEmployee);
    const cancelledRow = rows.find(r => Number(r.amount) === 999);
    // Voided by an effective_to before its own effective_from — the idiom this
    // table already uses for a superseded row. The reader never selects it.
    expect(new Date(cancelledRow!.effective_to) < new Date(cancelledRow!.effective_from)).toBe(true);
    expect((await getEmployeeComponents(futureRowEmployee, company, periodDate(2025, 6))).map(c => c.amount))
      .toEqual([30000]);
  });
});

describe('R-006 (separate defect, deliberately NOT fixed here)', () => {
  it('a line whose effective_from is the UI default month-end is skipped in its own period', async () => {
    // The batch UI defaults effectiveFrom to endOfMonth (2025-03-31) while
    // calculatePayrollRun evaluates near the end of the month but before it
    // (day 27 in SAST), so the line is never picked up in its own period.
    // Before K-025 it leaked into every LATER period; it no longer does, but the
    // in-period miss is R-006 and still reproduces.
    expect(await getEmployeeComponents(monthEndEmployee, company, periodDate(2025, 3))).toEqual([]);
    expect(await getEmployeeComponents(monthEndEmployee, company, periodDate(2025, 4))).toEqual([]);
  });
});
