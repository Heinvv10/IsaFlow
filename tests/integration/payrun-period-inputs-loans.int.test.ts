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
import parallelExport from '../../pages/api/payroll/parallel-run/export';
import cashRegister from '../../pages/api/payroll/runs/[id]/cash-register';
import { postPayrollJournalTool } from '../../src/lib/mcp/tools/writePayroll';
import type { McpToolContext } from '../../src/lib/mcp/types';
import {
  addBatchLines, createBatch, validateBatch,
} from '../../src/modules/accounting/services/payroll/payrollBatchService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { inputsFixture } from './payrun-period-inputs.helpers';
import type { Route } from './w3-01-payroll.helpers';
import { cashPayRegisterForRun } from '../../src/modules/accounting/services/payroll/cashPayRegisterService';
import { postPayrollRunJournal } from '../../src/modules/accounting/services/payroll/payrollJournalPostingService';
import { createExternalImport } from '../../src/modules/accounting/services/payroll/payrollExternalImportService';

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
  it('blocks every issue and posting gate before taking the loan, then clears after the instalment is paused and recalculated', async () => {
    const loan = await addLoan(30000);
    await recalculate(state.nov);
    const l = await line(state.nov);
    expect(l.net).toBeGreaterThan(0);
    expect(codes(l)).toEqual(['LOAN_INSTALMENT_EXCEEDS_PAY']);
    expect(l.validation_results[0]!.message).toContain('Wanda Test');
    const { blocker, plan, planHash } = (await preview(state.nov)).body.data!;
    expect(blocker).toMatchObject({ code: 'loan_instalment_exceeds_pay' });
    const detail = (blocker.detail as string).replace(/\s/g, ' ');
    for (const part of ['Wanda Test', 'W301-1', 'R-LOAN', 'blocked for manual review']) expect(detail).toContain(part);
    expect(plan.advisories.find((a: { code: string }) => a.code === 'loan_instalment_exceeds_pay')).toBeUndefined();
    expect((await doApprove(state.nov, planHash)).statusCode).toBe(400);
    const cashRefused = await call(
      cashRegister as Route, 'GET', `/api/payroll/runs/${state.nov}/cash-register`, state.nov,
    );
    expect(cashRefused.statusCode).toBe(400);
    expect(cashRefused.body.error).toMatchObject({
      details: { code: 'LOAN_INSTALMENT_EXCEEDS_PAY' },
    });
    expect(cashRefused.body.error?.message).toMatch(/blocked for manual review.*W301-1/i);
    await expect(cashPayRegisterForRun(state.coA, state.nov)).rejects.toThrow(/blocked for manual review.*W301-1/i);
    await expect(postPayrollRunJournal(state.coA, state.nov, fx.admin)).rejects.toThrow(/blocked for manual review.*W301-1/i);
    const mcpContext: McpToolContext = {
      userId: fx.admin, companyId: state.coA, companyRole: 'admin',
      scopes: ['write:payroll', 'write:post'], tokenJti: 'loan-block-test', oauthAppId: null,
    };
    const mcpRefused = await postPayrollJournalTool.handler({
      run_id: state.nov, dry_run: true, idempotency_key: 'blocked',
    }, mcpContext);
    expect(mcpRefused.isError).toBe(true);
    expect(mcpRefused.content[0]!.text).toContain('loan_instalment_exceeds_pay');
    const external = await createExternalImport(state.coA, {
      periodMonth: 11, periodYear: 2026, source: 'test', fileName: 'blocked.csv',
      componentsPresent: ['net'], rows: [{ employeeNumber: 'W301-1', employeeName: 'Worker One', amounts: { net: 0 } }],
      createdBy: fx.admin,
    });
    expect((await call(
      parallelExport as Route, 'GET', `/api/payroll/parallel-run/export?importId=${external.id}`, undefined,
      { query: { importId: external.id } },
    )).statusCode).toBe(400);
    expect(await header(state.nov)).toMatchObject({ status: 'calculated', journal_entry_id: null });
    expect((await pool.query('SELECT id FROM payroll_loan_payments WHERE loan_id = $1', [loan])).rows).toEqual([]);
    expect((await pool.query('SELECT paid_flag FROM payroll_loan_schedule WHERE loan_id = $1', [loan])).rows).toEqual([{ paid_flag: false }]);
    expect((await pool.query('SELECT outstanding_balance::float8 AS balance FROM payroll_loans WHERE id = $1', [loan])).rows).toEqual([{ balance: 30000 }]);

    await pool.query('UPDATE payroll_loan_schedule SET due_period_month = 12 WHERE loan_id = $1', [loan]);
    await recalculate(state.nov);
    const cleared = (await preview(state.nov)).body.data!;
    expect(cleared.blocker?.code).not.toBe('loan_instalment_exceeds_pay');
    await expect(cashPayRegisterForRun(state.coA, state.nov)).resolves.toMatchObject({ runId: state.nov });
    expect((await call(
      cashRegister as Route, 'GET', `/api/payroll/runs/${state.nov}/cash-register`, state.nov,
    )).statusCode).toBe(200);
    expect((await call(
      parallelExport as Route, 'GET', `/api/payroll/parallel-run/export?importId=${external.id}`, undefined,
      { query: { importId: external.id } },
    )).statusCode).toBe(200);
    await pool.query("UPDATE payroll_run_headers SET status = 'approved' WHERE id = $1", [state.nov]);
    const mcpCleared = await postPayrollJournalTool.handler({
      run_id: state.nov, dry_run: true, idempotency_key: 'cleared',
    }, mcpContext);
    expect(mcpCleared.isError).not.toBe(true);
    await pool.query("UPDATE payroll_run_headers SET status = 'calculated' WHERE id = $1", [state.nov]);
    expect((await doApprove(state.nov, cleared.planHash)).statusCode).toBe(200);
  });

  it('legacy warning-only runs tell every direct gate to recalculate without claiming the loan is unchanged', async () => {
    const loan = await addLoan(1000);
    await recalculate(state.nov);
    expect((await pool.query('SELECT id FROM payroll_loan_payments WHERE loan_id = $1', [loan])).rows).toHaveLength(1);
    await pool.query('UPDATE payroll_run_headers SET calculation_version = 1 WHERE id = $1', [state.nov]);
    await pool.query(
      `UPDATE payroll_run_lines
          SET validation_results = $2::jsonb
        WHERE run_id = $1`,
      [state.nov, JSON.stringify([{
        code: 'LOAN_INSTALMENT_EXCEEDS_PAY', severity: 'warning', rawNet: -100, loans: ['R-LOAN'],
        message: 'Legacy warning-only line',
      }])],
    );

    const approval = (await preview(state.nov)).body.data!;
    expect(approval.blocker).toMatchObject({ code: 'recalculate_required' });
    const approvalRefusal = await doApprove(state.nov, approval.planHash);
    expect(approvalRefusal.statusCode).toBe(400);
    expect(JSON.stringify(approvalRefusal.body)).toMatch(/recalculate/i);
    expect(JSON.stringify(approvalRefusal.body)).not.toMatch(/loan is unchanged/i);

    const cashRefusal = await cashPayRegisterForRun(state.coA, state.nov).catch((error: unknown) => error);
    expect(cashRefusal).toBeInstanceOf(Error);
    expect((cashRefusal as Error).message).toMatch(/earlier version.*recalculate/i);
    expect((cashRefusal as Error).message).not.toMatch(/loan is unchanged/i);
    const journalRefusal = await postPayrollRunJournal(state.coA, state.nov, fx.admin).catch((error: unknown) => error);
    expect(journalRefusal).toBeInstanceOf(Error);
    expect((journalRefusal as Error).message).toMatch(/earlier version.*recalculate/i);
    expect((journalRefusal as Error).message).not.toMatch(/loan is unchanged/i);

    const external = await createExternalImport(state.coA, {
      periodMonth: 11, periodYear: 2026, source: 'test', fileName: 'legacy-warning.csv',
      componentsPresent: ['net'], rows: [{ employeeNumber: 'W301-1', employeeName: 'Worker One', amounts: { net: 0 } }],
      createdBy: fx.admin,
    });
    const exportRefusal = await call(
      parallelExport as Route, 'GET', `/api/payroll/parallel-run/export?importId=${external.id}`, undefined,
      { query: { importId: external.id } },
    );
    expect(exportRefusal.statusCode).toBe(400);
    expect(JSON.stringify(exportRefusal.body)).toMatch(/earlier version.*recalculate/i);
    expect(JSON.stringify(exportRefusal.body)).not.toMatch(/loan is unchanged/i);
  });

  it('the grid still refuses an edit that makes it worse', async () => {
    await addLoan(30000);
    await recalculate(state.nov);
    expect((await set(state.nov, comp.union!, 100)).statusCode).toBe(400);
    expect((await set(state.nov, comp.overtime!, 100)).statusCode).toBe(200);
  });

  it('does not take the loan when other deductions already leave pay negative', async () => {
    const loan = await addLoan(1000);
    await addRow(comp.union!, 30000, '2026-01-01', null, true);
    await recalculate(state.nov);
    expect(codes(await line(state.nov))).toEqual(expect.arrayContaining([
      'DEDUCTIONS_EXCEED_PAY', 'LOAN_INSTALMENT_EXCEEDS_PAY',
    ]));
    expect((await pool.query('SELECT id FROM payroll_loan_payments WHERE loan_id = $1', [loan])).rows).toEqual([]);
    expect((await pool.query('SELECT outstanding_balance::float8 AS balance FROM payroll_loans WHERE id = $1', [loan])).rows)
      .toEqual([{ balance: 1000 }]);
  });

  it('keeps PAYE, UIF and SDL identical when only the cash instalment becomes blocked', async () => {
    await fx.addComponent(state.coA, 'Loan fringe', '3801', 'earning', true);
    const loan = await addLoan(1000, 'R-TAX', 0, 30000);
    await recalculate(state.nov);
    const collected = await line(state.nov);
    await pool.query('UPDATE payroll_loan_schedule SET principal = 30000, installment = 30000 WHERE loan_id = $1', [loan]);
    await recalculate(state.nov);
    const blocked = await line(state.nov);
    expect(codes(blocked)).toEqual(['LOAN_INSTALMENT_EXCEEDS_PAY']);
    expect({ paye: blocked.paye, uif: blocked.uif, uifEmployer: blocked.uifEmployer, sdl: blocked.sdl })
      .toEqual({ paye: collected.paye, uif: collected.uif, uifEmployer: collected.uifEmployer, sdl: collected.sdl });
    expect((blocked.component_breakdown as Array<{ sarsSourceCode: string; isNonCash?: boolean }>)
      .some((item) => item.sarsSourceCode === '3801' && item.isNonCash === true)).toBe(true);
  });

  it('allows an instalment exactly equal to available pay', async () => {
    const available = (await line(state.nov)).net as number;
    const loan = await addLoan(available);
    await recalculate(state.nov);
    expect(await line(state.nov)).toMatchObject({ net: 0, validation_results: [] });
    expect((await pool.query('SELECT principal_paid::float8 AS paid FROM payroll_loan_payments WHERE loan_id = $1', [loan])).rows)
      .toEqual([{ paid: available }]);
  });

  it('allows an instalment below available pay unchanged', async () => {
    await addLoan(1000);
    await recalculate(state.nov);
    expect(codes(await line(state.nov))).toEqual([]);
  });

  it('an edit recalculates twice and takes the instalment once', async () => {
    const loan = await addLoan(1000);
    await recalculate(state.nov);
    expect((await set(state.nov, comp.overtime!, 500)).statusCode).toBe(200);
    expect((await pool.query('SELECT principal_paid::float8 AS paid FROM payroll_loan_payments WHERE loan_id = $1', [loan])).rows).toEqual([{ paid: 1000 }]);
    expect((await pool.query('SELECT outstanding_balance::float8 AS b FROM payroll_loans WHERE id = $1', [loan])).rows[0]!.b).toBe(0);
  });
});

describe('the component a payslip shows the instalment on', () => {
  const breakdownIds = async () => ((await pool.query('SELECT component_breakdown FROM payroll_run_lines WHERE run_id = $1', [state.nov]))
    .rows[0]!.component_breakdown as Array<{ componentId: string }>).map((i) => i.componentId);

  it('a LOAN-coded earning is never it: the instalment stays a deduction', async () => {
    const plain = await line(state.nov);
    const earning = await fx.addComponent(state.coA, 'Loan earning', 'LOAN', 'earning', true);
    await pool.query(`UPDATE payroll_components SET created_at = '2000-01-01' WHERE id = $1`, [earning]); // made before the deduction
    await addLoan(1000);
    await recalculate(state.nov);
    const l = await line(state.nov);
    expect(l.gross).toBe(plain.gross);
    expect(l.net).toBeCloseTo(plain.net - 1000, 2);
    expect(await breakdownIds()).not.toContain(earning);
  });

  it('of two LOAN deductions, the first made is used, every time', async () => {
    await fx.addComponent(state.coA, 'Second loan', 'LOAN', 'deduction', false);
    await addLoan(1000);
    for (let i = 0; i < 3; i++) {
      await recalculate(state.nov);
      expect(await breakdownIds()).toContain(comp.loan);
    }
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
  const batchOf700 = async () => {
    const batch = await createBatch({
      companyId: state.coA, batchType: 'component_values', componentId: comp.overtime,
      description: 'R inputs lock batch', periodYear: 2026, periodMonth: 11,
      isRecurring: false, userId: fx.admin,
    });
    await addBatchLines(state.coA, batch.id, [{
      employeeId: state.employee, value: 700, effectiveFrom: new Date('2026-11-01'),
    }]);
    expect((await validateBatch(state.coA, batch.id)).ok).toBe(true);
    return batch.id;
  };
  const dropBatch = async (id: string) => {
    await pool.query('DELETE FROM payroll_batch_lines WHERE batch_id = $1', [id]);
    await pool.query('DELETE FROM payroll_batches WHERE id = $1', [id]);
  };
  const packageOf700 = async () => {
    const id = crypto.randomUUID();
    await pool.query(`INSERT INTO pay_packages (id, company_id, code, name) VALUES ($1, $2, 'R-LOCK', 'R lock package')`, [id, state.coA]);
    await pool.query(`INSERT INTO pay_package_components (package_id, component_id, amount, is_recurring) VALUES ($1, $2, 700, false)`, [id, comp.overtime]);
    return id;
  };
  const dropPackage = async (id: string) => {
    await pool.query('DELETE FROM pay_package_components WHERE package_id = $1', [id]);
    await pool.query('DELETE FROM pay_packages WHERE id = $1', [id]);
  };
  const postIt = (id: string) => call(postBatch as Route, 'POST', `/api/payroll/batches/${id}/post`, id);
  const applyIt = (packageId: string) => call(applyPackage as Route, 'POST', `/api/payroll/employees/${state.employee}/apply-package`, state.employee, {
    body: { packageId, effectiveFrom: '2026-11-01' },
  });
  /** Held past the 5s bound: a retryable 503, as every payroll lock wait answers, and nothing written. */
  const answersBusy = async (write: () => Promise<{ statusCode: number; body: { error?: { code?: string } } }>) => {
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`payroll_approval:${state.coA}`]);
      const res = await write();
      expect(res.statusCode, JSON.stringify(res.body)).toBe(503);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect(await rows(comp.overtime!)).toEqual([]);
  };

  it('batch posting held past the bound answers a retryable 503, and the batch stays postable', async () => {
    const id = await batchOf700();
    try {
      await answersBusy(() => postIt(id));
      expect((await postIt(id)).statusCode).toBe(200);
      expect(await rows(comp.overtime!)).toHaveLength(1);
    } finally {
      await dropBatch(id);
    }
  }, 15_000);

  it('pay-package application held past the bound answers a retryable 503, and can be retried', async () => {
    const id = await packageOf700();
    try {
      await answersBusy(() => applyIt(id));
      expect((await applyIt(id)).statusCode).toBe(200);
      expect(await rows(comp.overtime!)).toHaveLength(1);
    } finally {
      await dropPackage(id);
    }
  }, 15_000);

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
    const id = await batchOf700();
    try {
      await waitsForPayrollLock(() => postIt(id));
    } finally {
      await dropBatch(id);
    }
  });

  it('pay-package application waits for the company payroll lock before inserting assignments', async () => {
    const id = await packageOf700();
    try {
      await waitsForPayrollLock(() => applyIt(id));
    } finally {
      await dropPackage(id);
    }
  });
});
