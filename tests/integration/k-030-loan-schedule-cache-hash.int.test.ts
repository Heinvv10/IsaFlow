/**
 * K-030 RED — the loan schedule cache key ignores every financial term.
 *
 * `buildInputsHash` (loanScheduleService.ts:88) hashes only the loan id, its
 * events and its rate points. `updateLoan` can change principal, rate, term and
 * residual without touching any of those, so `getOrComputeSchedule` keeps
 * serving the pre-edit amortisation.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { getOrComputeSchedule } from '../../src/modules/accounting/services/loans/loanScheduleService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const otherCompany = crypto.randomUUID();
const loanId = crypto.randomUUID();
const touchLoanId = crypto.randomUUID();
const residualLoanId = crypto.randomUUID();
const revertLoanId = crypto.randomUUID();

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K-030 loan fixture']);
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [otherCompany, 'K-030 other tenant']);
  for (const [id, reference] of [
    [loanId, 'K030-LOAN'],
    [touchLoanId, 'K030-TOUCH'],
    [residualLoanId, 'K030-RESIDUAL'],
    [revertLoanId, 'K030-REVERT'],
  ] as const) {
    await pool.query(
      `INSERT INTO loans(id,company_id,reference,principal,start_date,term_months,
         rate_mode,fixed_rate,margin,residual,status)
       VALUES($1,$2,$3,100000,'2026-01-31',60,'FIXED',12,0,0,'active')`,
      [id, company, reference],
    );
  }
});

afterAll(async () => {
  try {
    await pool.query(
      `DELETE FROM loan_schedule_rows WHERE run_id IN
         (SELECT id FROM loan_schedule_runs WHERE company_id=$1)`,
      [company],
    );
    await pool.query('DELETE FROM loan_schedule_runs WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM loans WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [[company, otherCompany]]);
  } finally {
    await pool.end();
  }
});

it('recomputes the schedule after the principal and rate are edited', async () => {
  const before = await getOrComputeSchedule(company, loanId);
  expect(before.cached).toBe(false);
  const openingBefore = before.rows[0]!.opening;
  expect(openingBefore).toBeCloseTo(100000, 2);

  // The user edits the loan itself. No event, no rate point.
  await pool.query(
    `UPDATE loans SET principal=250000, fixed_rate=18, term_months=84, updated_at=now()
     WHERE id=$1`,
    [loanId],
  );

  const after = await getOrComputeSchedule(company, loanId);
  expect(after.cached).toBe(false);
  expect(after.rows[0]!.opening).toBeCloseTo(250000, 2);
  expect(after.rows.length).toBe(84);
});

it('still serves the cache when only updated_at is touched', async () => {
  const first = await getOrComputeSchedule(company, touchLoanId);
  expect(first.cached).toBe(false);

  await pool.query('UPDATE loans SET updated_at=now() WHERE id=$1', [touchLoanId]);

  const second = await getOrComputeSchedule(company, touchLoanId);
  expect(second.cached).toBe(true);
  expect(second.runId).toBe(first.runId);
});

it('recomputes when only the residual changes', async () => {
  const before = await getOrComputeSchedule(company, residualLoanId);
  expect(before.cached).toBe(false);
  const closingBefore = before.rows[before.rows.length - 1]!.closing;

  await pool.query('UPDATE loans SET residual=20000 WHERE id=$1', [residualLoanId]);

  const after = await getOrComputeSchedule(company, residualLoanId);
  expect(after.cached).toBe(false);
  expect(after.rows[after.rows.length - 1]!.closing).not.toBeCloseTo(closingBefore, 2);
});

it('reuses the original run when the edit is reverted', async () => {
  const original = await getOrComputeSchedule(company, revertLoanId);
  expect(original.cached).toBe(false);

  await pool.query('UPDATE loans SET principal=175000 WHERE id=$1', [revertLoanId]);
  const edited = await getOrComputeSchedule(company, revertLoanId);
  expect(edited.cached).toBe(false);
  expect(edited.runId).not.toBe(original.runId);

  await pool.query('UPDATE loans SET principal=100000 WHERE id=$1', [revertLoanId]);
  const reverted = await getOrComputeSchedule(company, revertLoanId);
  expect(reverted.cached).toBe(true);
  expect(reverted.runId).toBe(original.runId);
});

it('does not serve one company the schedule of another company loan', async () => {
  await expect(getOrComputeSchedule(otherCompany, loanId)).rejects.toThrow(/not found/);
});
