// K-022 follow-up: the edge cases around reversing a run's loan applications.
//
// Covers the review findings on the first fix (b77557ce):
//   - a reopened run whose GL journal is still posted must be refused;
//   - a loan closed between calculations is reversed without re-application,
//     so the deleted payment must leave a payroll_loan_payment_reversals tombstone;
//   - two concurrent calculations must not reproduce K-022 itself;
//   - a payment stranded by a deleted run (run_id set NULL by the FK) must be
//     reclaimed;
//   - the restore must not push a clamped balance above the loan principal.
// Source: src/modules/accounting/services/payroll/payrollRunLoanApplication.ts
//         src/modules/accounting/services/payroll/payrollLoanReversal.ts
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { calculatePayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';
import {
  applyRunLoans,
  PayrollLoanLockTimeoutError,
  PayrollRunJournalPostedError,
} from '@/modules/accounting/services/payroll/payrollRunLoanApplication';
import { closeLoan } from '@/modules/accounting/services/payroll/payrollLoanService';
import { als } from '@/lib/als';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const tenants: Tenant[] = [];

interface Tenant {
  company: string;
  employee: string;
  run: string;
  loan: string;
}

/** One company, one employee on R20,000, one loan with a single instalment due 3/2026. */
async function createTenant(opts: {
  principal: number;
  outstanding: number;
  instalment: number;
}): Promise<Tenant> {
  const t: Tenant = {
    company: crypto.randomUUID(),
    employee: crypto.randomUUID(),
    run: crypto.randomUUID(),
    loan: crypto.randomUUID(),
  };
  const salaryComp = crypto.randomUUID();
  const loanComp = crypto.randomUUID();

  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [t.company, 'K022 edge case']);
  await pool.query(
    `INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,start_date,status)
     VALUES($1,$2,'K022-E','Nomsa','Khumalo',DATE '2020-01-01','active')`,
    [t.employee, t.company],
  );
  await pool.query(
    `INSERT INTO payroll_components(id,company_id,name,sars_source_code,component_type,is_taxable,is_uif_applicable,is_sdl_applicable)
     VALUES($1,$3,'Basic salary','3601','earning',true,true,true),
           ($2,$3,'Loan repayment','LOAN','deduction',false,false,false)`,
    [salaryComp, loanComp, t.company],
  );
  await pool.query(
    `INSERT INTO payroll_employee_components(employee_id,component_id,amount,effective_from)
     VALUES($1,$2,20000,DATE '2020-01-01')`,
    [t.employee, salaryComp],
  );
  await pool.query(
    `INSERT INTO payroll_run_headers(id,company_id,period_month,period_year,status)
     VALUES($1,$2,3,2026,'draft')`,
    [t.run, t.company],
  );
  // Loan rate equals the SARS official rate, so no fringe benefit arises and
  // the instalment is pure principal.
  await pool.query(
    `INSERT INTO payroll_loans(id,company_id,employee_id,loan_number,description,principal,
       annual_interest_rate,term_months,method,start_date,first_deduction_period_year,
       first_deduction_period_month,status,outstanding_balance)
     VALUES($1,$2,$3,'K022-EDGE','Staff loan',$4,0.085,12,'straight_line',
       DATE '2026-03-01',2026,3,'active',$5)`,
    [t.loan, t.company, t.employee, opts.principal, opts.outstanding],
  );
  await pool.query(
    `INSERT INTO payroll_loan_schedule(loan_id,sequence,due_period_year,due_period_month,
       opening_balance,interest,principal,installment,closing_balance,paid_flag)
     VALUES($1,1,2026,3,$2,0,$3,$3,$4,false)`,
    [t.loan, opts.outstanding, opts.instalment, Math.max(0, opts.outstanding - opts.instalment)],
  );
  tenants.push(t);
  return t;
}

async function loanState(loanId: string) {
  const rows = (await pool.query(
    `SELECT outstanding_balance, total_principal_paid, total_interest_charged, status
       FROM payroll_loans WHERE id=$1`, [loanId])).rows;
  expect(rows).toHaveLength(1);
  const r = rows[0];
  return {
    outstanding: Number(r.outstanding_balance),
    principalPaid: Number(r.total_principal_paid),
    interestCharged: Number(r.total_interest_charged),
    status: String(r.status),
  };
}

async function loanDeductionOnPayslip(runId: string): Promise<number> {
  const rows = (await pool.query(
    'SELECT component_breakdown FROM payroll_run_lines WHERE run_id=$1', [runId])).rows;
  expect(rows.length).toBeGreaterThan(0);
  return rows
    .flatMap(r => r.component_breakdown as Array<Record<string, unknown>>)
    .filter(c => String(c.sarsSourceCode ?? c.sars_source_code ?? '') === 'LOAN')
    .reduce((sum, c) => sum + Number(c.amount ?? 0), 0);
}

async function paymentRowCount(loanId: string): Promise<number> {
  const rows = (await pool.query(
    'SELECT COUNT(*)::int AS n FROM payroll_loan_payments WHERE loan_id=$1', [loanId])).rows;
  expect(rows).toHaveLength(1);
  return Number(rows[0].n);
}

/**
 * paid_flag on the loan's schedule. Guarded so a regression that deletes the
 * schedule row fails on the assertion rather than on a TypeError.
 */
async function schedulePaidFlags(loanId: string): Promise<boolean[]> {
  const rows = (await pool.query(
    'SELECT paid_flag FROM payroll_loan_schedule WHERE loan_id=$1 ORDER BY sequence',
    [loanId])).rows;
  expect(rows.length).toBeGreaterThan(0);
  return rows.map(r => Boolean(r.paid_flag));
}

/** Tombstone rows for a company, guarded the same way. */
async function tombstones(companyId: string, expected: number) {
  const rows = (await pool.query(
    `SELECT loan_id, run_id, principal_reversed, reapplied, stranded
       FROM payroll_loan_payment_reversals WHERE company_id=$1
      ORDER BY reversed_at`, [companyId])).rows;
  expect(rows).toHaveLength(expected);
  return rows;
}

afterAll(async () => {
  try {
    for (const t of tenants) {
      await pool.query('DELETE FROM payroll_loan_payment_reversals WHERE company_id=$1', [t.company]);
      await pool.query('DELETE FROM payroll_loan_payments WHERE loan_id=$1', [t.loan]);
      await pool.query('DELETE FROM payroll_loan_schedule WHERE loan_id=$1', [t.loan]);
      await pool.query('DELETE FROM payroll_loans WHERE company_id=$1', [t.company]);
      await pool.query('DELETE FROM payroll_run_lines WHERE run_id=$1', [t.run]);
      await pool.query('UPDATE payroll_run_headers SET journal_entry_id=NULL WHERE company_id=$1', [t.company]);
      await pool.query('DELETE FROM payroll_run_headers WHERE company_id=$1', [t.company]);
      await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [t.company]);
      await pool.query('DELETE FROM payroll_employee_components WHERE employee_id=$1', [t.employee]);
      await pool.query('DELETE FROM payroll_components WHERE company_id=$1', [t.company]);
      await pool.query('DELETE FROM payroll_employees WHERE company_id=$1', [t.company]);
      await pool.query('DELETE FROM companies WHERE id=$1', [t.company]);
    }
  } finally {
    await pool.end();
  }
});

describe('K-022 loan reversal edge cases', () => {
  it('refuses to recalculate a reopened run whose GL journal is still posted', async () => {
    const t = await createTenant({ principal: 12000, outstanding: 10000, instalment: 1000 });
    await calculatePayrollRun(t.run, t.company);
    const applied = await loanState(t.loan);
    expect(applied.outstanding).toBe(9000);

    // Approve-then-reopen leaves journal_entry_id set on purpose: the GL entry
    // posted at approval is NOT reversed by reopenPayrollRun.
    const journal = crypto.randomUUID();
    await pool.query(
      `INSERT INTO gl_journal_entries(id,company_id,entry_date,description,created_by,status)
       VALUES($1,$2,DATE '2026-03-31','Payroll March 2026',$3,'posted')`,
      [journal, t.company, crypto.randomUUID()],
    );
    await pool.query(
      "UPDATE payroll_run_headers SET status='calculated', journal_entry_id=$2 WHERE id=$1",
      [t.run, journal],
    );

    await expect(calculatePayrollRun(t.run, t.company))
      .rejects.toBeInstanceOf(PayrollRunJournalPostedError);

    // Nothing moved: the subledger still agrees with the posted journal.
    expect(await loanState(t.loan)).toEqual(applied);
    expect(await paymentRowCount(t.loan)).toBe(1);
    expect(await schedulePaidFlags(t.loan)).toEqual([true]);
  });

  it('records a tombstone when a loan closed between calculations is reversed but not re-applied', async () => {
    const t = await createTenant({ principal: 12000, outstanding: 10000, instalment: 1000 });
    await calculatePayrollRun(t.run, t.company);
    expect(await loanDeductionOnPayslip(t.run)).toBe(1000);

    await closeLoan(t.company, t.loan, 'written_off', crypto.randomUUID());
    await calculatePayrollRun(t.run, t.company);

    // listActiveLoansForRun offers only active loans, so nothing is re-applied.
    const after = await loanState(t.loan);
    expect(after.status).toBe('written_off');
    expect(after.outstanding).toBe(10000);
    expect(after.principalPaid).toBe(0);
    expect(after.interestCharged).toBe(0);
    expect(await paymentRowCount(t.loan)).toBe(0);
    expect(await loanDeductionOnPayslip(t.run)).toBe(0);

    // The deleted payment row survives as a tombstone, flagged as never
    // re-applied and as this run's own work rather than a reclaim.
    const [tomb] = await tombstones(t.company, 1);
    expect(String(tomb.loan_id)).toBe(t.loan);
    expect(String(tomb.run_id)).toBe(t.run);
    expect(Number(tomb.principal_reversed)).toBe(1000);
    expect(tomb.reapplied).toBe(false);
    expect(tomb.stranded).toBe(false);
  });

  it('keeps the deduction and the single balance reduction under two concurrent calculations', async () => {
    const t = await createTenant({ principal: 12000, outstanding: 10000, instalment: 1000 });
    // The race needs something to reverse: two concurrent RE-calculations,
    // each of which would undo and re-apply the same instalment.
    await calculatePayrollRun(t.run, t.company);

    const results = await Promise.allSettled([
      calculatePayrollRun(t.run, t.company),
      calculatePayrollRun(t.run, t.company),
    ]);
    // The unique key on (run_id, employee_id) may reject the loser's payslip
    // write; the loan subledger must be correct either way.
    expect(results.some(r => r.status === 'fulfilled')).toBe(true);

    expect(await paymentRowCount(t.loan)).toBe(1);
    const after = await loanState(t.loan);
    expect(after.outstanding).toBe(9000);
    expect(after.principalPaid).toBe(1000);
    expect(await loanDeductionOnPayslip(t.run)).toBe(1000);
  });

  it('serialises two request transactions overlapping on the same run', async () => {
    // Two real connections, each holding an open transaction, driven through
    // applyRunLoans in a deliberately overlapping order — the second starts
    // before the first commits.
    const t = await createTenant({ principal: 12000, outstanding: 10000, instalment: 1000 });
    await calculatePayrollRun(t.run, t.company);

    const input = {
      companyId: t.company,
      runId: t.run,
      periodYear: 2026,
      periodMonth: 3,
      officialRate: 0.085,
      journalEntryId: null,
    };
    const first = await pool.connect();
    const second = await pool.connect();
    try {
      await first.query('BEGIN');
      await second.query('BEGIN');

      const firstWork = als.run(
        { client: first, userId: 'k022-a', companyId: t.company, claims: {} },
        () => applyRunLoans(input),
      );
      const secondWork = als.run(
        { client: second, userId: 'k022-b', companyId: t.company, claims: {} },
        () => applyRunLoans(input),
      );
      const settled = await Promise.allSettled([firstWork, secondWork]);
      expect(settled.filter(r => r.status === 'fulfilled').length).toBeGreaterThan(0);

      await first.query('COMMIT');
      await second.query('COMMIT');
    } finally {
      first.release();
      second.release();
    }

    // One instalment, taken once, whichever order the two transactions landed.
    expect(await paymentRowCount(t.loan)).toBe(1);
    const after = await loanState(t.loan);
    expect(after.outstanding).toBe(9000);
    expect(after.principalPaid).toBe(1000);
    expect(await schedulePaidFlags(t.loan)).toEqual([true]);
  });

  it('refuses to take a NEW instalment on a run whose GL journal is still posted', async () => {
    // The mirror of the reverse-path guard: nothing to undo, but the journal
    // posted at approval never saw this deduction and will not be re-posted.
    const t = await createTenant({ principal: 12000, outstanding: 10000, instalment: 1000 });
    const journal = crypto.randomUUID();
    await pool.query(
      `INSERT INTO gl_journal_entries(id,company_id,entry_date,description,created_by,status)
       VALUES($1,$2,DATE '2026-03-31','Payroll March 2026',$3,'posted')`,
      [journal, t.company, crypto.randomUUID()],
    );
    await pool.query(
      "UPDATE payroll_run_headers SET status='calculated', journal_entry_id=$2 WHERE id=$1",
      [t.run, journal],
    );

    await expect(calculatePayrollRun(t.run, t.company))
      .rejects.toBeInstanceOf(PayrollRunJournalPostedError);

    // Nothing taken, nothing tombstoned.
    expect(await paymentRowCount(t.loan)).toBe(0);
    expect(await schedulePaidFlags(t.loan)).toEqual([false]);
    const after = await loanState(t.loan);
    expect(after.outstanding).toBe(10000);
    expect(after.principalPaid).toBe(0);
    await tombstones(t.company, 0);
  });

  it('classifies a contended loan row as a lock timeout, before writing anything', async () => {
    // A competing FOR UPDATE on the loan row from a second connection. With the
    // lock taken up front the wait is classified; without it, execution reaches
    // the tombstone INSERT and the payment DELETE before blocking, and the
    // failure surfaces as a raw Postgres cancellation.
    const t = await createTenant({ principal: 12000, outstanding: 10000, instalment: 1000 });
    await calculatePayrollRun(t.run, t.company);

    const holder = await pool.connect();
    const worker = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM payroll_loans WHERE id=$1 FOR UPDATE', [t.loan]);
      await worker.query('BEGIN');

      const err = await als.run(
        { client: worker, userId: 'probe', companyId: t.company, claims: {} },
        () => applyRunLoans({
          companyId: t.company,
          runId: t.run,
          periodYear: 2026,
          periodMonth: 3,
          officialRate: 0.085,
          journalEntryId: null,
        }),
      ).then(() => null, (e: unknown) => e);

      expect(err).toBeInstanceOf(PayrollLoanLockTimeoutError);

      await worker.query('ROLLBACK');
      await holder.query('ROLLBACK');
    } finally {
      holder.release();
      worker.release();
    }

    // It blocked before touching anything, so no tombstone and the payment
    // from the first calculation is intact.
    await tombstones(t.company, 0);
    expect(await paymentRowCount(t.loan)).toBe(1);
    const after = await loanState(t.loan);
    expect(after.outstanding).toBe(9000);
  });

  it('restores the exact pre-run balance when the forward path clamped at zero', async () => {
    // Outstanding 400, instalment 1000: applyLoanToRun clamps to 0 and records
    // loan_balance_before = 400, so the undo must come back to 400 — not to the
    // 1000 that adding the principal back would give.
    const t = await createTenant({ principal: 12000, outstanding: 400, instalment: 1000 });
    await calculatePayrollRun(t.run, t.company);
    const settled = await loanState(t.loan);
    expect(settled.outstanding).toBe(0);
    expect(settled.status).toBe('settled');

    const payment = (await pool.query(
      'SELECT loan_balance_before, schedule_row_id FROM payroll_loan_payments WHERE loan_id=$1',
      [t.loan])).rows;
    expect(payment).toHaveLength(1);
    expect(Number(payment[0].loan_balance_before)).toBe(400);
    expect(payment[0].schedule_row_id).not.toBeNull();

    await pool.query("UPDATE payroll_loans SET status='written_off' WHERE id=$1", [t.loan]);
    await calculatePayrollRun(t.run, t.company);

    const after = await loanState(t.loan);
    expect(after.outstanding).toBe(400);
    expect(after.principalPaid).toBe(0);
    expect(await schedulePaidFlags(t.loan)).toEqual([false]);
  });

  it('clears only the schedule row the payment flagged, not every row for the period', async () => {
    // The schedule is unique on (loan_id, sequence), not on period, so two rows
    // can fall in one period. applyLoanToRun flags exactly one, and the undo
    // must clear that one — a period-wide clear would wipe a flag it never set.
    const t = await createTenant({ principal: 12000, outstanding: 10000, instalment: 1000 });
    await pool.query(
      `INSERT INTO payroll_loan_schedule(loan_id,sequence,due_period_year,due_period_month,
         opening_balance,interest,principal,installment,closing_balance,paid_flag)
       VALUES($1,2,2026,3,9000,0,1000,1000,8000,true)`,
      [t.loan],
    );
    expect(await schedulePaidFlags(t.loan)).toEqual([false, true]);

    await calculatePayrollRun(t.run, t.company);
    expect(await schedulePaidFlags(t.loan)).toEqual([true, true]);

    // Recalculate: sequence 1 is undone and retaken, sequence 2 is untouched.
    await calculatePayrollRun(t.run, t.company);
    expect(await schedulePaidFlags(t.loan)).toEqual([true, true]);
    expect(await loanDeductionOnPayslip(t.run)).toBe(1000);
    const after = await loanState(t.loan);
    expect(after.outstanding).toBe(9000);
    expect(after.principalPaid).toBe(1000);
  });

  it('puts the caller\'s lock_timeout back when it returns', async () => {
    // SET LOCAL is scoped to the transaction, not to the block. Under withAuth
    // withTransaction only nests a savepoint, so a 5s timeout left in force
    // would apply to the run-lines rebuild and every later statement.
    const t = await createTenant({ principal: 12000, outstanding: 10000, instalment: 1000 });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '17s'");

      await als.run(
        { client, userId: 'probe', companyId: t.company, claims: {} },
        () => applyRunLoans({
          companyId: t.company,
          runId: t.run,
          periodYear: 2026,
          periodMonth: 3,
          officialRate: 0.085,
          journalEntryId: null,
        }),
      );

      const after = (await client.query("SELECT current_setting('lock_timeout') AS v")).rows;
      expect(after).toHaveLength(1);
      expect(after[0].v).toBe('17s');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('reclaims an instalment stranded by a deleted run', async () => {
    const t = await createTenant({ principal: 12000, outstanding: 10000, instalment: 1000 });
    await calculatePayrollRun(t.run, t.company);

    // payroll_loan_payments.run_id is ON DELETE SET NULL, so deleting the run
    // leaves the instalment recorded with paid_flag true and no run to undo it.
    await pool.query('DELETE FROM payroll_run_lines WHERE run_id=$1', [t.run]);
    await pool.query('DELETE FROM payroll_run_headers WHERE id=$1', [t.run]);
    const orphaned = (await pool.query(
      'SELECT run_id FROM payroll_loan_payments WHERE loan_id=$1', [t.loan])).rows;
    expect(orphaned).toHaveLength(1);
    expect(orphaned[0].run_id).toBeNull();

    // A replacement run for the same period takes the deduction again.
    const replacement = crypto.randomUUID();
    await pool.query(
      `INSERT INTO payroll_run_headers(id,company_id,period_month,period_year,status)
       VALUES($1,$2,3,2026,'draft')`,
      [replacement, t.company],
    );
    t.run = replacement;
    await calculatePayrollRun(replacement, t.company);

    expect(await loanDeductionOnPayslip(replacement)).toBe(1000);
    expect(await paymentRowCount(t.loan)).toBe(1);
    // The stranded row was tombstoned against the replacement run, marked as a
    // reclaim rather than a self-reversal, and retaken.
    const [tomb] = await tombstones(t.company, 1);
    expect(String(tomb.run_id)).toBe(replacement);
    expect(tomb.reapplied).toBe(true);
    expect(tomb.stranded).toBe(true);
    const after = await loanState(t.loan);
    expect(after.outstanding).toBe(9000);
    expect(after.principalPaid).toBe(1000);
  });

});
