/**
 * Wave 5 DR: IRP3(b) fixed-percentage / IRP3(c) fixed-amount directives on regular pay, through the real routes and SQL.
 *
 * - one regular-pay directive per employee per period, judged under pg_advisory_xact_lock(company, employee) at create
 *   and at approve: a request that meets the lock waits, then sees the holder's row and is refused 400, nothing written;
 * - another company's directive never reaches this company's run, even naming this company's employee;
 * - a run applies the directive (20% of R20 000 = R4 000; G21 Rev 1 p. 15), the line leaves the year to date, the
 *   approval gate refuses a run whose directive changed after calculation;
 * - the lump-sum readers refuse or ignore it: the stand-alone payment (400, no payment row), the run lump-sum filing;
 * - a directive that taxed an approved run cannot be deleted (409).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import directives from '../../pages/api/accounting/tax-directives';
import directive from '../../pages/api/accounting/tax-directives/[id]';
import type { Route } from './w3-01-payroll.helpers';
import {
  applyStandalone, approveRun, calculateRun, cleanSeveranceFixtures, codes, createRunFor, previewRun, runLine,
  seedRetrenchedEmployee, type SeveranceFixture,
} from './p3-severance.helpers';
import { loadRegularPayDirectives } from '@/modules/accounting/services/payroll/payrollRunRegularDirective';
import { loadPayeYearToDate } from '@/modules/accounting/services/payroll/payrollYearToDate';
import { listRunLumpSums } from '@/modules/accounting/services/payroll/payrollLumpSumFiling';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: SeveranceFixture;
let other: SeveranceFixture;

const PCT = { directive_type: 'fixed_percentage', tax_rate: 0.2, effective_date: '2026-03-01' };
const post = (body: Record<string, unknown>, fx = f) =>
  fx.call(directives as Route, 'POST', '/api/accounting/tax-directives', undefined, { body: { employee_id: fx.employee, ...body } });
const patch = (id: string, body: Record<string, unknown>) =>
  f.call(directive as Route, 'PATCH', `/api/accounting/tax-directives/${id}`, id, { body });
const regularRows = async (company: string) => Number((await pool.query(
  "SELECT count(*) AS n FROM tax_directives WHERE company_id = $1 AND directive_type IN ('fixed_percentage', 'fixed_amount') AND status <> 'cancelled'",
  [company])).rows[0]!.n);
const cancelAll = () => pool.query("UPDATE tax_directives SET status = 'cancelled' WHERE company_id = $1", [f.company]);
const lockKey = () => `tax_directive_regular_pay:${f.company}:${f.employee}`;

/** Hold the employee's advisory lock in a transaction of our own, insert `insert` under it, and commit after `holdMs`. */
async function underHeldLock<T>(request: () => Promise<T>, insertStatus: 'pending' | 'approved', holdMs = 800): Promise<{ result: T; waited: boolean }> {
  const holder = await pool.connect();
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey()]);
    let settled = false;
    const pending = request().finally(() => { settled = true; });
    await new Promise(r => setTimeout(r, holdMs));
    const waited = !settled;
    await holder.query(
      `INSERT INTO tax_directives (company_id, employee_id, employee_name, directive_type, amount, tax_rate, effective_date, status)
       VALUES ($1, $2, 'Wanda Test', 'fixed_percentage', 0, 0.25, '2026-03-01', $3)`, [f.company, f.employee, insertStatus]);
    await holder.query('COMMIT');
    return { result: await pending, waited };
  } finally {
    holder.release();
  }
}

beforeAll(async () => {
  f = await seedRetrenchedEmployee(pool, '2026-04-30', 'DR regular directive company');
  other = await seedRetrenchedEmployee(pool, '2026-04-30', 'DR other company');
  await pool.query("UPDATE payroll_employees SET end_date = NULL, status = 'active' WHERE id = ANY($1)", [[f.employee, other.employee]]);
});

afterAll(async () => {
  try { await cleanSeveranceFixtures(pool, [f, other].filter(Boolean)); } finally { await pool.end(); }
});

describe('create: the new types and their fields', () => {
  it('a fixed percentage stores amount 0, the rate and no tax amount; a fixed amount its tax amount', async () => {
    await cancelAll();
    const p = await post(PCT);
    expect(p.statusCode, JSON.stringify(p.body)).toBe(201);
    expect([p.body.data!.amount, p.body.data!.taxRate, p.body.data!.taxAmount]).toEqual([0, 0.2, null]);
    await cancelAll();
    const a = await post({ directive_type: 'fixed_amount', tax_amount: 2500, effective_date: '2026-03-01' });
    expect(a.statusCode, JSON.stringify(a.body)).toBe(201);
    expect([a.body.data!.amount, a.body.data!.taxRate, a.body.data!.taxAmount]).toEqual([0, null, 2500]);
  });

  it('a gross amount on a percentage directive: 400, nothing written', async () => {
    await cancelAll();
    const r = await post({ ...PCT, amount: 30000 });
    expect(r.statusCode).toBe(400);
    expect(await regularRows(f.company)).toBe(0);
  });
});

describe('one regular-pay directive per employee per period', () => {
  it('an overlapping create: 400 naming the other, nothing written', async () => {
    await cancelAll();
    expect((await post(PCT)).statusCode).toBe(201);
    const r = await post({ ...PCT, tax_rate: 0.3, effective_date: '2026-06-01' });
    expect(r.statusCode).toBe(400);
    expect(r.body.error?.message).toMatch(/overlaps/);
    expect(await regularRows(f.company)).toBe(1);
  });

  it('a create waits on the employee lock, then sees the holder\'s pending row: 400, one row', async () => {
    await cancelAll();
    const { result, waited } = await underHeldLock(() => post(PCT), 'pending');
    expect(waited).toBe(true);
    expect(result.statusCode, JSON.stringify(result.body)).toBe(400);
    expect(await regularRows(f.company)).toBe(1);
  });

  it('an approve waits on the employee lock, then sees the holder\'s approved row: 400, still pending', async () => {
    await cancelAll();
    const id = String((await post({ ...PCT, effective_date: '2026-06-01' })).body.data!.id);
    // The holder's approved row (2026-03-01 to the tax year's end) overlaps it.
    const { result, waited } = await underHeldLock(() => patch(id, { status: 'approved' }), 'approved');
    expect(waited).toBe(true);
    expect(result.statusCode, JSON.stringify(result.body)).toBe(400);
    expect((await pool.query('SELECT status FROM tax_directives WHERE id = $1', [id])).rows[0]!.status).toBe('pending');
  });

  it('re-approving a cancelled directive over an approved one: 400', async () => {
    await cancelAll();
    const first = String((await post(PCT)).body.data!.id);
    await patch(first, { status: 'cancelled' });
    const second = String((await post(PCT)).body.data!.id);
    expect((await patch(second, { status: 'approved' })).statusCode).toBe(200);
    const r = await patch(first, { status: 'approved' });
    expect(r.statusCode).toBe(400);
    expect((await pool.query('SELECT status FROM tax_directives WHERE id = $1', [first])).rows[0]!.status).toBe('cancelled');
  });
});

describe('tenancy', () => {
  it('another company\'s approved directive naming this company\'s employee never applies', async () => {
    await cancelAll();
    await pool.query(
      `INSERT INTO tax_directives (company_id, employee_id, employee_name, directive_type, amount, tax_rate, effective_date, status)
       VALUES ($1, $2, 'Wanda Test', 'fixed_percentage', 0, 0.2, '2026-03-01', 'approved')`, [other.company, f.employee]);
    const loaded = await loadRegularPayDirectives(f.company, [f.employee], { year: 2026, month: 3 });
    expect(loaded.get(f.employee)?.current ?? null).toBeNull();
  });
});

describe('a run applies it, and the readers that pay lump sums refuse it', () => {
  let directiveId = '';
  let runId = '';

  it('20% of R20 000 = R4 000 on the March line, flagged off the tables', async () => {
    await cancelAll();
    directiveId = String((await post(PCT)).body.data!.id);
    expect((await patch(directiveId, { status: 'approved' })).statusCode).toBe(200);
    runId = await createRunFor(f, 3);
    await calculateRun(f, runId);
    const line = await runLine(pool, runId, f.employee);
    expect(line.paye).toBe(4000);
    expect(line.validation_results).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'PAYE_OUTSIDE_TABLES', treatment: 'directive', directive: expect.objectContaining({ id: directiveId }) }),
    ]));
  });

  it('approved, the month is out of April\'s year to date (no re-true by the tables)', async () => {
    const approved = await approveRun(f, runId);
    expect(approved.statusCode, JSON.stringify(approved.body)).toBe(200);
    const ytd = await loadPayeYearToDate(f.company, crypto.randomUUID(), { year: 2026, month: 4 }, [f.employee]);
    expect([ytd.get(f.employee)?.periods ?? 0, ytd.get(f.employee)?.tablePaye ?? 0]).toEqual([0, 0]);
  });

  it('the stand-alone lump-sum payment refuses it: 400, no payment row', async () => {
    const r = await applyStandalone(f, directiveId);
    expect(r.statusCode, JSON.stringify(r.body)).toBe(400);
    expect(r.body.error?.message).toMatch(/cannot be paid as a lump sum/);
    expect((await pool.query('SELECT count(*)::int AS n FROM tax_directive_payments WHERE tax_directive_id = $1', [directiveId])).rows[0]!.n).toBe(0);
  });

  it('the run lump-sum filing ignores it, even on a breakdown item that names it', async () => {
    await pool.query(
      `UPDATE payroll_run_lines SET component_breakdown = component_breakdown || $3::jsonb WHERE run_id = $1 AND employee_id = $2`,
      [runId, f.employee, JSON.stringify([{ componentId: 'forged', sarsSourceCode: '3901', amount: 1000, isTaxable: true, directive: { id: directiveId, paye: 200 } }])]);
    const filed = await listRunLumpSums(f.company, { start: '2026-03-01', end: '2027-02-28' }, f.employee);
    expect(filed.get(f.employee) ?? []).toEqual([]);
  });

  it('it cannot be deleted while an approved run was taxed by it: 409', async () => {
    const r = await f.call(directive as Route, 'DELETE', `/api/accounting/tax-directives/${directiveId}`, directiveId);
    expect(r.statusCode).toBe(409);
    expect(r.body.error?.message).toMatch(/decided PAYE on the 2026-03 payroll run/);
  });

  it('cancelled after an April run was calculated: approval refuses regular_directive_changed; recalculated, the tables', async () => {
    const april = await createRunFor(f, 4);
    await calculateRun(f, april);
    expect((await runLine(pool, april, f.employee)).paye).toBe(4000);
    expect((await patch(directiveId, { status: 'cancelled' })).statusCode).toBe(200);
    const plan = await previewRun(f, april);
    expect(plan.body.data?.blocker?.code, JSON.stringify(plan.body)).toBe('regular_directive_changed');
    await calculateRun(f, april);
    const line = await runLine(pool, april, f.employee);
    expect(codes(line.validation_results)).not.toContain('PAYE_OUTSIDE_TABLES');
    expect((await previewRun(f, april)).body.data?.blocker?.code ?? null).not.toBe('regular_directive_changed');
  });
});
