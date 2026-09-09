/**
 * K-025: a once-off payroll batch (is_recurring = false) posted
 * payroll_employee_components rows with effective_to = NULL, so the amount was
 * picked up again in every later period. postBatch now closes a once-off
 * assignment at the end of the batch period; recurring batches stay open-ended.
 *
 * Reader under test: payrollComponentService.getEmployeeComponents — the
 * function payrollRunService.calculatePayrollRun calls per employee, at
 * `new Date(period.year, period.month - 1, 28)`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  createBatch, addBatchLines, validateBatch, postBatch,
} from '../../src/modules/accounting/services/payroll/payrollBatchService';
import { getEmployeeComponents } from '../../src/modules/accounting/services/payroll/payrollComponentService';

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
const otherEmployee = crypto.randomUUID();
const bonusComponent = crypto.randomUUID();
const allowanceComponent = crypto.randomUUID();
const travelTaxable = crypto.randomUUID();
const travelNonTaxable = crypto.randomUUID();
const otherComponent = crypto.randomUUID();
const batchIds: string[] = [];

// payrollRunService.calculatePayrollRun evaluates components at day 28.
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
  await addEmployee(otherEmployee, otherCompany, 'E-K025-6');
  await addComponent(bonusComponent, company, 'March bonus', '3605');
  await addComponent(allowanceComponent, company, 'Standing allowance', '3713');
  await addComponent(travelTaxable, company, 'Travel taxable', '3702');
  await addComponent(travelNonTaxable, company, 'Travel non-taxable', '3703');
  await addComponent(otherComponent, otherCompany, 'Other tenant bonus', '3605');

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
  // Second tenant, same shape — must be untouched by any of the above.
  await postOne(otherCompany, { batchType: 'component_values', componentId: otherComponent, isRecurring: false, month: 3 },
    { employeeId: otherEmployee, value: 400, effectiveFrom: new Date('2025-03-01') });
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM payroll_employee_components WHERE employee_id = ANY($1::uuid[])',
      [[onceOffEmployee, recurringEmployee, explicitEndEmployee, travelEmployee, monthEndEmployee, otherEmployee]]);
    await pool.query('DELETE FROM payroll_batch_lines WHERE batch_id = ANY($1::uuid[])', [batchIds]);
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

  it('an effective_from after the period end never produces an inverted range', async () => {
    const rows = await assignments(monthEndEmployee);
    expect(rows).toHaveLength(1);
    expect(new Date(rows[0].effective_to) >= new Date(rows[0].effective_from)).toBe(true);
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

describe('R-006 (separate defect, deliberately NOT fixed here)', () => {
  it('a line whose effective_from is the UI default month-end is skipped in its own period', async () => {
    // The batch UI defaults effectiveFrom to endOfMonth (2025-03-31) while
    // calculatePayrollRun evaluates at day 28, so the line is never picked up.
    // Before K-025 it leaked into every LATER period; it no longer does, but the
    // in-period miss is R-006 and still reproduces.
    expect(await getEmployeeComponents(monthEndEmployee, company, periodDate(2025, 3))).toEqual([]);
    expect(await getEmployeeComponents(monthEndEmployee, company, periodDate(2025, 4))).toEqual([]);
  });
});
