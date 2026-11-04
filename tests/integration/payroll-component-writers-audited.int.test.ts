/**
 * Security review (2026-11-02), through the real routes:
 *   1. Every writer of payroll_employee_components leaves a 'payroll_employee_component' audit row (dates only, no
 *      amount; actor and channel) in its own transaction: assign (POST …/components), package apply (every row it
 *      ends and every row it inserts) and batch post. So the approval gate's "changed after calculation" check
 *      (payrollRunRecalcGate) sees all of them: each, after the run was calculated, refuses approval until recalculated.
 *   2. "Paid" is judged by what the paid run read: a row superseded AFTER the run that read it was calculated still
 *      counts as read in that month; and a package apply that would cut a row a paid run read is refused.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { calculatedRun, cleanPayrollCompanies, routeCaller, seedPayrollCompany, type Route } from './w3-01-payroll.helpers';
import components from '../../pages/api/payroll/employees/[id]/components';
import applyPackage from '../../pages/api/payroll/employees/[id]/apply-package';
import postBatchRoute from '../../pages/api/payroll/batches/[id]/post';
import calculate from '../../pages/api/payroll/runs/[id]/calculate';
import approve from '../../pages/api/payroll/runs/[id]/approve';
import journalPlan from '../../pages/api/payroll/runs/[id]/journal-plan';
import { addBatchLines, createBatch, validateBatch } from '@/modules/accounting/services/payroll/payrollBatchService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const company = crypto.randomUUID();
const admin = crypto.randomUUID();
const pkg = crypto.randomUUID();
let call: ReturnType<typeof routeCaller>;
let employee = '';
let salary = '';
let salaryRow = '';
let bonus = '';
const AMOUNT = 4321.09;

const blocker = async (run: string) =>
  ((await call(journalPlan as Route, 'GET', `/api/payroll/runs/${run}/journal-plan`, run)).body.data as { blocker: { code: string; detail: string } | null }).blocker;
const recalc = (run: string) => call(calculate as Route, 'POST', `/api/payroll/runs/${run}/calculate`, run);
async function approveRun(run: string) {
  const plan = await call(journalPlan as Route, 'GET', `/api/payroll/runs/${run}/journal-plan`, run);
  return call(approve as Route, 'POST', `/api/payroll/runs/${run}/approve`, run, { body: { expectedPlanHash: plan.body.data?.planHash } });
}
const auditsFor = async (rowIds: string[]) => (await pool.query(
  "SELECT entity_id::text AS id, user_id, changes FROM audit_log WHERE company_id=$1 AND entity_type='payroll_employee_component' AND entity_id = ANY($2::uuid[])",
  [company, rowIds])).rows as Array<{ id: string; user_id: string; changes: { fields: Array<{ field: string }>; metadata: Record<string, string> } }>;

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'Writers audited']);
  salaryRow = await seedPayrollCompany(pool, company);
  ({ employee_id: employee, component_id: salary } = (await pool.query('SELECT employee_id, component_id FROM payroll_employee_components WHERE id=$1', [salaryRow])).rows[0]);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [admin, `${admin}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [company, admin]);
  const token = await new SignJWT({ sub: admin, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  call = routeCaller({ [admin]: token }, { user: admin, company });
  bonus = crypto.randomUUID();
  await pool.query("INSERT INTO payroll_components(id,company_id,name,sars_source_code,component_type) VALUES($1,$2,'Bonus','3605','earning')", [bonus, company]);
  await pool.query("INSERT INTO pay_packages(id,company_id,code,name) VALUES($1,$2,'WA-PKG','Writers package')", [pkg, company]);
  await pool.query('INSERT INTO pay_package_components(package_id,component_id,amount,is_recurring) VALUES($1,$2,$3,false)', [pkg, bonus, AMOUNT]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM audit_log WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM payroll_batch_lines WHERE batch_id IN (SELECT id FROM payroll_batches WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM payroll_batches WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM pay_package_components WHERE package_id=$1', [pkg]);
    await pool.query('DELETE FROM pay_packages WHERE id=$1', [pkg]);
    await cleanPayrollCompanies(pool, [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [admin]);
  } finally { await pool.end(); }
});

describe('1. every writer is audited, and refuses a calculated run until it is recalculated', () => {
  it.each([
    ['assign (REST)', 5, async () => {
      const out = await call(components as Route, 'POST', `/api/payroll/employees/${employee}/components`, employee,
        { body: { componentId: bonus, amount: AMOUNT, effectiveFrom: '2026-05-10', isRecurring: false } });
      expect(out.statusCode, JSON.stringify(out.body)).toBe(201);
      return [String(out.body.data!.id)];
    }],
    ['package apply', 6, async () => {
      const out = await call(applyPackage as Route, 'POST', `/api/payroll/employees/${employee}/apply-package`, employee,
        { body: { packageId: pkg, effectiveFrom: '2026-06-10' } });
      expect(out.statusCode, JSON.stringify(out.body)).toBe(200);
      return (await pool.query("SELECT id FROM payroll_employee_components WHERE employee_id=$1 AND component_id=$2 AND effective_from='2026-06-10'", [employee, bonus])).rows.map(r => String(r.id));
    }],
    ['batch post', 7, async () => {
      const batch = await createBatch({ companyId: company, batchType: 'component_values', componentId: bonus, description: 'WA batch',
        periodYear: 2026, periodMonth: 7, isRecurring: false, userId: admin });
      await addBatchLines(company, batch.id, [{ employeeId: employee, value: AMOUNT, effectiveFrom: new Date('2026-07-10') }]);
      expect((await validateBatch(company, batch.id)).ok).toBe(true);
      const out = await call(postBatchRoute as Route, 'POST', `/api/payroll/batches/${batch.id}/post`, batch.id);
      expect(out.statusCode, JSON.stringify(out.body)).toBe(200);
      return (await pool.query("SELECT id FROM payroll_employee_components WHERE employee_id=$1 AND effective_from='2026-07-10'", [employee])).rows.map(r => String(r.id));
    }],
  ] as const)('%s after calculation', async (_n, month, write) => {
    const run = await calculatedRun(call, month);
    expect(await blocker(run)).toBeNull();
    const rowIds = await write();
    const refused = await blocker(run);
    expect(refused?.code).toBe('components_changed_after_calculation');
    expect(refused?.detail).toMatch(/W301-1.*recalculate/i);
    const audits = await auditsFor(rowIds);
    expect(audits.length).toBeGreaterThanOrEqual(rowIds.length);
    for (const a of audits) {
      expect(a.user_id).toBe(admin);
      expect(a.changes.metadata).toMatchObject({ channel: 'rest' });
      expect(JSON.stringify(a.changes)).not.toMatch(/amount|4321/);
    }
    expect((await recalc(run)).statusCode).toBe(200);
    expect(await blocker(run)).toBeNull();
  });

  it('a package apply audits every row it ends as well as those it inserts', async () => {
    // The July once-off above was posted by a batch, not by this package: an apply over it is refused, saying to end it.
    const july = String((await pool.query("SELECT id FROM payroll_employee_components WHERE employee_id=$1 AND effective_from='2026-07-10'", [employee])).rows[0]!.id);
    const refused = await call(applyPackage as Route, 'POST', `/api/payroll/employees/${employee}/apply-package`, employee, { body: { packageId: pkg, effectiveFrom: '2026-06-20' } });
    expect(refused.statusCode).toBe(400);
    expect(refused.body.error?.message).toMatch(/posted by a batch.*End or move/);
    // The advice, followed through the End route: it is cancelled (no run paid it), and the apply goes through.
    const ended = await call(components as Route, 'DELETE', `/api/payroll/employees/${employee}/components?aid=${july}`, employee,
      { body: { effectiveTo: '2026-07-31' }, query: { aid: july } });
    expect(ended.statusCode, JSON.stringify(ended.body)).toBe(200);
    const out = await call(applyPackage as Route, 'POST', `/api/payroll/employees/${employee}/apply-package`, employee,
      { body: { packageId: pkg, effectiveFrom: '2026-06-20' } });
    expect(out.statusCode, JSON.stringify(out.body)).toBe(200);
    const cut = (await pool.query("SELECT id FROM payroll_employee_components WHERE employee_id=$1 AND effective_from='2026-06-10'", [employee])).rows.map(r => String(r.id));
    const kinds = (await auditsFor(cut)).map(a => a.changes.metadata.kind);
    expect(kinds).toEqual(expect.arrayContaining(['package_assign', 'package_supersede']));
  });
});

describe('2. paid is what the paid run read', () => {
  it('a package that would cut a row an approved run read is refused, nothing written', async () => {
    const feb = await calculatedRun(call, 2);
    expect((await approveRun(feb)).statusCode).toBe(200);
    await pool.query('UPDATE pay_package_components SET component_id=$2 WHERE package_id=$1', [pkg, salary]);
    const before = (await pool.query('SELECT effective_to, superseded_at FROM payroll_employee_components WHERE id=$1', [salaryRow])).rows[0];
    const out = await call(applyPackage as Route, 'POST', `/api/payroll/employees/${employee}/apply-package`, employee,
      { body: { packageId: pkg, effectiveFrom: '2026-02-15' } });
    expect(out.statusCode).toBe(400);
    expect(out.body.error?.message).toMatch(/2026-02 .*already paid/);
    expect((await pool.query('SELECT effective_to, superseded_at FROM payroll_employee_components WHERE id=$1', [salaryRow])).rows[0]).toEqual(before);
    await pool.query('UPDATE pay_package_components SET component_id=$2 WHERE package_id=$1', [pkg, bonus]);
  });

  it('a once-off superseded after the run that read it was calculated still counts as read: cancelling it is refused', async () => {
    const once = await call(components as Route, 'POST', `/api/payroll/employees/${employee}/components`, employee,
      { body: { componentId: bonus, amount: 300, effectiveFrom: '2026-03-05', effectiveTo: '2026-03-14', isRecurring: false } });
    const id = String(once.body.data!.id);
    const march = await calculatedRun(call, 3);
    expect((await approveRun(march)).statusCode).toBe(200);
    // Marked superseded after March was calculated (as a later supersede would).
    await pool.query('UPDATE payroll_employee_components SET superseded_at = now() WHERE id=$1', [id]);
    const out = await call(components as Route, 'DELETE', `/api/payroll/employees/${employee}/components?aid=${id}`, employee,
      { body: { effectiveTo: '2026-03-10', cancel: true }, query: { aid: id } });
    expect(out.statusCode).toBe(400);
    expect(out.body.error?.message).toMatch(/already paid in 2026-03/);
  });
});
