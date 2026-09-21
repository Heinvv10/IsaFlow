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
import {
  getOrComputeSchedule,
  previewSchedule,
} from '../../src/modules/accounting/services/loans/loanScheduleService';
import { als } from '../../src/lib/als';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const otherCompany = crypto.randomUUID();
const loanId = crypto.randomUUID();
const touchLoanId = crypto.randomUUID();
const residualLoanId = crypto.randomUUID();
const revertLoanId = crypto.randomUUID();
const tieLoanId = crypto.randomUUID();
const lockLoanId = crypto.randomUUID();
const previewLoanId = crypto.randomUUID();
const bulkLoanId = crypto.randomUUID();

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K-030 loan fixture']);
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [otherCompany, 'K-030 other tenant']);
  for (const [id, reference] of [
    [loanId, 'K030-LOAN'],
    [touchLoanId, 'K030-TOUCH'],
    [residualLoanId, 'K030-RESIDUAL'],
    [revertLoanId, 'K030-REVERT'],
    [tieLoanId, 'K030-TIE'],
    [lockLoanId, 'K030-LOCK'],
    [previewLoanId, 'K030-PREVIEW'],
    [bulkLoanId, 'K030-BULK'],
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
    await pool.query('DELETE FROM loan_events WHERE company_id=$1', [company]);
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
  expect(new Date(second.computedAt).getTime()).toBeGreaterThanOrEqual(
    new Date(first.computedAt).getTime(),
  );
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

/** The query GL posting, compliance and period close all use to pick a run. */
async function latestRunId(loan: string): Promise<string> {
  const { rows } = await pool.query(
    'SELECT id FROM loan_schedule_runs WHERE loan_id=$1 ORDER BY computed_at DESC LIMIT 1',
    [loan],
  );
  return String(rows[0]!.id);
}

it('leaves the reverted run newest, so GL posting reads the current terms', async () => {
  const original = await getOrComputeSchedule(company, revertLoanId);
  expect(original.cached).toBe(false);

  await pool.query('UPDATE loans SET principal=175000 WHERE id=$1', [revertLoanId]);
  const edited = await getOrComputeSchedule(company, revertLoanId);
  expect(edited.cached).toBe(false);
  expect(edited.runId).not.toBe(original.runId);
  expect(await latestRunId(revertLoanId)).toBe(edited.runId);

  await pool.query('UPDATE loans SET principal=100000 WHERE id=$1', [revertLoanId]);
  const reverted = await getOrComputeSchedule(company, revertLoanId);
  expect(reverted.cached).toBe(true);
  expect(reverted.runId).toBe(original.runId);
  expect(reverted.rows[0]!.opening).toBeCloseTo(100000, 2);
  // What the ledger would post must be the schedule the screen shows.
  expect(await latestRunId(revertLoanId)).toBe(reverted.runId);
});

it('does not serve one company the schedule of another company loan', async () => {
  await expect(getOrComputeSchedule(otherCompany, loanId)).rejects.toThrow(/not found/);
});

it('stays cached when two events share a date, whatever order the rows come back in', async () => {
  await pool.query(
    `INSERT INTO loan_events(loan_id,company_id,event_date,kind,amount)
     VALUES($1,$2,'2026-06-30','LUMP',5000),($1,$2,'2026-06-30','LUMP',9000)`,
    [tieLoanId, company],
  );

  const first = await getOrComputeSchedule(company, tieLoanId);
  expect(first.cached).toBe(false);

  // Repeat reads must not churn a new run per read (M1: hash keyed on tie order).
  for (let i = 0; i < 3; i += 1) {
    const again = await getOrComputeSchedule(company, tieLoanId);
    expect(again.cached).toBe(true);
    expect(again.runId).toBe(first.runId);
  }

  const { rows } = await pool.query(
    'SELECT count(*)::int AS n FROM loan_schedule_runs WHERE loan_id=$1',
    [tieLoanId],
  );
  expect(rows[0]!.n).toBe(1);
});

it('holds the loan row against a concurrent edit until the touch commits', async () => {
  // N1: the cache-hit touch must not promote a run built on terms the loan has
  // since left. FOR SHARE pins the loan for the request transaction, exactly as
  // withAuth opens it (als.run over a client with BEGIN already issued).
  await getOrComputeSchedule(company, lockLoanId);

  const reader = await pool.connect();
  let blocked: boolean;
  try {
    await reader.query('BEGIN');
    blocked = await als.run(
      { client: reader, userId: 'k030', companyId: company, claims: {} },
      async () => {
        const hit = await getOrComputeSchedule(company, lockLoanId);
        expect(hit.cached).toBe(true);
        // Still inside the request transaction: an editor must not get in.
        const editor = await pool.connect();
        try {
          await editor.query('BEGIN');
          await editor.query('SET LOCAL lock_timeout = 1000');
          await editor.query('UPDATE loans SET principal=999999 WHERE id=$1', [lockLoanId]);
          return false; // the edit got through — the lock was not held
        } catch (err) {
          return /lock timeout|canceling statement/i.test(String(err));
        } finally {
          await editor.query('ROLLBACK').catch(() => undefined);
          editor.release();
        }
      },
    );
    await reader.query('ROLLBACK');
  } finally {
    reader.release();
  }

  expect(blocked).toBe(true);
});

it('lets the edit through once the reading transaction has ended', async () => {
  const editor = await pool.connect();
  try {
    await editor.query('BEGIN');
    await editor.query('SET LOCAL lock_timeout = 2000');
    await editor.query('UPDATE loans SET principal=180000 WHERE id=$1', [lockLoanId]);
    await editor.query('COMMIT');
  } finally {
    editor.release();
  }

  const after = await getOrComputeSchedule(company, lockLoanId);
  expect(after.cached).toBe(false);
  expect(after.rows[0]!.opening).toBeCloseTo(180000, 2);
  expect(await latestRunId(lockLoanId)).toBe(after.runId);
});

/** Runs `fn` the way withAuth does: an open transaction bound to the request context. */
async function inRequestTx<T>(fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await als.run(
      { client, userId: 'k030', companyId: company, claims: {} },
      fn,
    );
    await client.query('ROLLBACK');
    return out;
  } finally {
    client.release();
  }
}

/** Attempts a loan edit on its own connection, failing fast instead of queueing. */
async function tryEdit(loan: string, principal: number): Promise<boolean> {
  const editor = await pool.connect();
  try {
    await editor.query('BEGIN');
    await editor.query('SET LOCAL lock_timeout = 1000');
    await editor.query('UPDATE loans SET principal=$2 WHERE id=$1', [loan, principal]);
    return true;
  } catch {
    return false;
  } finally {
    await editor.query('ROLLBACK').catch(() => undefined);
    editor.release();
  }
}

it('does not block a loan edit while a dry-run preview is open', async () => {
  // R3-1: previewSchedule persists nothing, so it has no stake in the touch window
  // and must not hold the loan. The user previewing "what if" is the one about to edit.
  const edited = await inRequestTx(async () => {
    const rows = await previewSchedule(company, previewLoanId);
    expect(rows.length).toBe(60);
    return tryEdit(previewLoanId, 123456);
  });
  expect(edited).toBe(true);
});

it('persists every schedule row in the bulk insert, in period order', async () => {
  // R3-2: the per-period insert loop became one unnest statement. The rows the
  // cache serves must still be the rows the engine produced.
  const computed = await getOrComputeSchedule(company, bulkLoanId);
  expect(computed.cached).toBe(false);
  expect(computed.rows.length).toBe(60);

  const cached = await getOrComputeSchedule(company, bulkLoanId);
  expect(cached.cached).toBe(true);
  expect(cached.rows.length).toBe(computed.rows.length);
  expect(cached.rows.map((r) => r.period)).toEqual(computed.rows.map((_, i) => i + 1));
  for (const [i, row] of cached.rows.entries()) {
    const src = computed.rows[i]!;
    expect(row.date).toBe(src.date);
    expect(row.opening).toBeCloseTo(src.opening, 2);
    expect(row.interest).toBeCloseTo(src.interest, 2);
    expect(row.principal).toBeCloseTo(src.principal, 2);
    expect(row.closing).toBeCloseTo(src.closing, 2);
    expect(row.skip).toBe(src.skip);
  }
  expect(cached.rows[cached.rows.length - 1]!.closing).toBeCloseTo(0, 2);
});
