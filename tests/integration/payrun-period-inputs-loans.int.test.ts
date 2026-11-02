/**
 * Pay-run period inputs beside the other writers (master plan wave 3, R): what the loan
 * service takes, the calculation an edit is judged against, and the employee page's
 * assignment racing a cell. Disposable fixture DB only.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import components from '../../pages/api/payroll/employees/[id]/components';
import applyPackage from '../../pages/api/payroll/employees/[id]/apply-package';
import postBatch from '../../pages/api/payroll/batches/[id]/post';
import {
  addBatchLines, createBatch, validateBatch,
} from '../../src/modules/accounting/services/payroll/payrollBatchService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { inputsFixture } from './payrun-period-inputs.helpers';
import type { Route } from './w3-01-payroll.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const fx = inputsFixture(pool);
const { state, set, rows, line, header, preview, doApprove, call, addRow, recalculate, addLoan, lockWaiters } = fx;
const comp = state.comp;

beforeAll(fx.setUp);
beforeEach(fx.freshCompany);
afterEach(fx.dropCompany);
afterAll(fx.tearDown);

const codes = (l: { validation_results: Array<{ code: string }> }) => l.validation_results.map((v) => v.code);

describe('judged against a fresh calculation, not the stored line', () => {
  it('a line gone stale below nil: an edit that narrows it is allowed', async () => {
    await addRow(comp.union!, 30000, '2026-01-01', null, true); // nothing has recalculated since
    expect(codes(await line(state.nov))).toEqual([]);
    expect((await set(state.nov, comp.overtime!, 1000)).statusCode).toBe(200);
  });

  it('a stale flag excuses nothing: a deduction that takes the line below nil is refused', async () => {
    await addRow(comp.union!, 30000, '2026-01-01', null, true);
    await recalculate(state.nov);
    await pool.query('DELETE FROM payroll_employee_components WHERE component_id = $1', [comp.union]); // nothing recalculates
    expect((await set(state.nov, comp.union!, 20000)).statusCode).toBe(400);
    expect(await rows(comp.union!)).toEqual([]);
  });
});

describe('a loan instalment above pay', () => {
  it('blocks approval because the loan subledger would exceed the deductions liability', async () => {
    await addLoan(30000);
    await recalculate(state.nov);
    const l = await line(state.nov);
    expect(l.net).toBe(0);
    expect(codes(l)).toEqual(['LOAN_INSTALMENT_EXCEEDS_PAY']);
    const { blocker, plan, planHash } = (await preview(state.nov)).body.data!;
    expect(blocker).toMatchObject({ code: 'deductions_exceed_pay' });
    expect(blocker.detail).toContain('W301-1');
    const advisory = plan.advisories.find((a: { code: string }) => a.code === 'loan_instalment_exceeds_pay');
    expect(advisory.detail).toContain('W301-1');
    expect((await doApprove(state.nov, planHash)).statusCode).toBe(400);
    expect(await header(state.nov)).toMatchObject({ status: 'calculated', journal_entry_id: null });
  });

  it('the grid still refuses an edit that makes it worse', async () => {
    await addLoan(30000);
    await recalculate(state.nov);
    expect((await set(state.nov, comp.union!, 100)).statusCode).toBe(400);
    expect((await set(state.nov, comp.overtime!, 100)).statusCode).toBe(200);
  });

  it('a shortfall that survives without the instalment stays a blocker, and says what can be changed', async () => {
    await addLoan(1000);
    await addRow(comp.union!, 30000, '2026-01-01', null, true);
    await recalculate(state.nov);
    const { blocker } = (await preview(state.nov)).body.data!;
    expect(blocker).toMatchObject({ code: 'deductions_exceed_pay' });
    expect(blocker.detail).toContain('W301-1');
    expect(blocker.detail).toContain('on the employee page');
  });

  it('an edit recalculates twice and takes the instalment once', async () => {
    const loan = await addLoan(1000);
    await recalculate(state.nov);
    expect((await set(state.nov, comp.overtime!, 500)).statusCode).toBe(200);
    expect((await pool.query('SELECT principal_paid::float8 AS paid FROM payroll_loan_payments WHERE loan_id = $1', [loan])).rows).toEqual([{ paid: 1000 }]);
    expect((await pool.query('SELECT outstanding_balance::float8 AS b FROM payroll_loans WHERE id = $1', [loan])).rows[0]!.b).toBe(0);
  });
});

describe('assigning a component beside the grid', () => {
  const assign = () => call(components as Route, 'POST', `/api/payroll/employees/${state.employee}/components`, state.employee, {
    body: { componentId: comp.overtime, amount: 700, effectiveFrom: '2026-11-01', isRecurring: false },
  });

  it('waits for the company payroll lock, so it cannot land between a cell\'s read and its write', async () => {
    const holder = await pool.connect();
    const key = `payroll_approval:${state.coA}`;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
      const pending = assign();
      await vi.waitFor(async () => expect(await lockWaiters(key)).toBe(1), { timeout: 4000, interval: 25 });
      expect(await rows(comp.overtime!)).toEqual([]);
      await holder.query('COMMIT');
      expect((await pending).statusCode).toBe(201);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
  });

  it('gives up within the bound with a retryable refusal, writing nothing', async () => {
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`payroll_approval:${state.coA}`]);
      const res = await assign();
      expect(res.statusCode, JSON.stringify(res.body)).toBe(503);
      expect(res.body.error?.message).not.toContain('null');
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect(await rows(comp.overtime!)).toEqual([]);
  }, 15_000);
});

describe('other component writers beside the grid', () => {
  const waitsForPayrollLock = async (write: () => Promise<{ statusCode: number }>) => {
    const holder = await pool.connect();
    const key = `payroll_approval:${state.coA}`;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
      const pending = write();
      await vi.waitFor(async () => expect(await lockWaiters(key)).toBe(1), { timeout: 4000, interval: 25 });
      expect(await rows(comp.overtime!)).toEqual([]);
      await holder.query('COMMIT');
      expect((await pending).statusCode).toBe(200);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect(await rows(comp.overtime!)).toHaveLength(1);
  };

  it('batch posting waits for the company payroll lock before inserting assignments', async () => {
    const batch = await createBatch({
      companyId: state.coA, batchType: 'component_values', componentId: comp.overtime,
      description: 'R inputs lock batch', periodYear: 2026, periodMonth: 11,
      isRecurring: false, userId: fx.admin,
    });
    await addBatchLines(state.coA, batch.id, [{
      employeeId: state.employee, value: 700, effectiveFrom: new Date('2026-11-01'),
    }]);
    try {
      expect((await validateBatch(state.coA, batch.id)).ok).toBe(true);
      await waitsForPayrollLock(() => call(
        postBatch as Route, 'POST', `/api/payroll/batches/${batch.id}/post`, batch.id,
      ));
    } finally {
      await pool.query('DELETE FROM payroll_batch_lines WHERE batch_id = $1', [batch.id]);
      await pool.query('DELETE FROM payroll_batches WHERE id = $1', [batch.id]);
    }
  });

  it('pay-package application waits for the company payroll lock before inserting assignments', async () => {
    const packageId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO pay_packages (id, company_id, code, name) VALUES ($1, $2, 'R-LOCK', 'R lock package')`,
      [packageId, state.coA],
    );
    await pool.query(
      `INSERT INTO pay_package_components (package_id, component_id, amount, is_recurring)
       VALUES ($1, $2, 700, false)`,
      [packageId, comp.overtime],
    );
    try {
      await waitsForPayrollLock(() => call(
        applyPackage as Route, 'POST', `/api/payroll/employees/${state.employee}/apply-package`, state.employee,
        { body: { packageId, effectiveFrom: '2026-11-01' } },
      ));
    } finally {
      await pool.query('DELETE FROM pay_package_components WHERE package_id = $1', [packageId]);
      await pool.query('DELETE FROM pay_packages WHERE id = $1', [packageId]);
    }
  });
});
