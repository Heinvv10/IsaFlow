// K-021 atomicity of `reverseReconciledTransaction`: the fallback-date period
// cases. The original entry sits in a CLOSED earlier period, so the reversal
// falls back to today:
//   5. no period covers today — the poster creates the year, so the reversal
//      still posts, inside the new period;
//   6. today's period is closed — the pre-flight refuses BEFORE the unwind.
// Cases 1-4 are in k021-reversal-atomicity.int.test.ts; the shared tenant and
// fixtures in k021-reversal-atomicity.helpers.ts. This file has its own tenant.
// Every refusal here is a 4xx, which `withAuth` COMMITs — so "nothing written"
// is a claim about the database after the commit, not about an aborted tx.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { k021World, newFixture, parkedEnd, parkedStart, UNTOUCHED } from './k021-reversal-atomicity.helpers';
import { fmtDate } from '@/lib/fmtDate';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const w = k021World(pool);
const { company, nowPeriod, tokens } = w;

const closedToday = newFixture();
const noPeriodToday = newFixture();
const fixtures = [closedToday, noPeriodToday];

beforeAll(() => w.seed([[closedToday, 'closed-today'], [noPeriodToday, 'no-period-today']]));

afterAll(() => w.teardown(fixtures));

describe('K-021 reversal atomicity', () => {
  // A guard that fronts a write must refuse only what the write refuses.
  // createJournalEntry calls ensureFiscalPeriodForDate, which CREATES the fiscal
  // year on demand, so a tenant whose current year does not exist yet could
  // always reverse an old allocation — the year was built on the way through.
  // Refusing `no_period` in the pre-flight would turn that into a 400.
  // Mutation: refuse on `status !== 'open'` and this goes red.
  it('still reverses when NO period covers today, because the poster creates the year', async () => {
    // Moved out of today's range rather than deleted. Nothing in this file has
    // posted into it yet, but parking stays safe if an earlier test ever does:
    // gl_journal_entries and gl_account_balances both carry an FK to it.
    // Parking it leaves today uncovered, which is the condition under test.
    // A period lies inside its fiscal year (migration 940), so it moves into the
    // year holding the parked month, and the current year it leaves empty is
    // removed: today's year does not exist, as for a tenant that never made it.
    const year = await pool.query('SELECT fiscal_year_id AS id FROM fiscal_periods WHERE id=$1', [nowPeriod]);
    await pool.query(
      'UPDATE fiscal_periods SET start_date=$2::date, end_date=$3::date, fiscal_year_id=public.fiscal_year_ensure($4, $2::date) WHERE id=$1',
      [nowPeriod, parkedStart, parkedEnd, company]);
    await pool.query(
      'DELETE FROM fiscal_years fy WHERE fy.id=$1 AND NOT EXISTS (SELECT 1 FROM fiscal_periods fp WHERE fp.fiscal_year_id=fy.id)',
      [year.rows[0].id]);
    const todaysYear = await pool.query(
      'SELECT COUNT(*)::int AS n FROM fiscal_years WHERE company_id=$1 AND start_date <= $2::date AND end_date >= $2::date',
      [company, fmtDate(new Date())]);
    expect(todaysYear.rows[0].n).toBe(0);
    // Today is the process's local date the poster books on (SAST on the
    // runner), not the CI cluster's UTC CURRENT_DATE, which lags it from 00:00
    // to 02:00 SAST.
    const before = await pool.query(
      'SELECT COUNT(*)::int AS n FROM fiscal_periods WHERE company_id=$1 AND start_date <= $2::date AND end_date >= $2::date',
      [company, fmtDate(new Date())]);
    expect(before.rows[0].n).toBe(0);

    const dayBefore = fmtDate(new Date());
    const result = await w.reverse(noPeriodToday.bankTx, tokens.token, company);
    const dayAfter = fmtDate(new Date());
    expect(result.state.statusCode).toBe(200);
    expect((await w.readState(noPeriodToday)).reversalJournals).toBe(1);
    // The contra is dated the poster's today: either side of the call, only
    // because the call may straddle midnight.
    const booked = await pool.query(
      'SELECT entry_date::text AS d FROM gl_journal_entries WHERE company_id=$1 AND reversal_of_id=$2',
      [company, noPeriodToday.je]);
    expect([dayBefore, dayAfter]).toContain(booked.rows[0].d);

    // The year was created on the way through, and the contra is IN it — a
    // reversal posted with a NULL period would be invisible to every
    // period-bounded report, which is the outcome the auto-create exists to stop.
    // Counted for the day the contra was booked on, so a call that straddles
    // midnight is measured against the date the poster actually used.
    const after = await pool.query(
      `SELECT COUNT(*)::int AS n FROM fiscal_periods fp, gl_journal_entries je
       WHERE fp.company_id=$1 AND je.company_id=$1 AND je.reversal_of_id=$2
         AND fp.start_date <= je.entry_date AND fp.end_date >= je.entry_date`,
      [company, noPeriodToday.je]);
    expect(after.rows[0].n).toBe(1);
    const contra = await pool.query(
      'SELECT fiscal_period_id FROM gl_journal_entries WHERE company_id=$1 AND reversal_of_id=$2',
      [company, noPeriodToday.je]);
    expect(contra.rows[0].fiscal_period_id).not.toBeNull();
  });

  // Runs LAST, after the no-period test: the year that test auto-created is
  // the period covering today it closes, for the rest of the file. Vitest runs
  // a file's it()s in order.
  it('refuses BEFORE the unwind when the fallback reversal date has no open period', async () => {
    // Today and tomorrow (local dates): the fallback is the poster's own today,
    // which is tomorrow if the call straddles midnight.
    await pool.query(
      "UPDATE fiscal_periods SET status='closed' WHERE company_id=$1 AND start_date <= $2::date + 1 AND end_date >= $2::date",
      [company, fmtDate(new Date())]);
    const result = await w.reverse(closedToday.bankTx, tokens.token, company);

    expect(result.state.statusCode).not.toBe(200);
    expect(await w.readState(closedToday)).toEqual(UNTOUCHED);
    // The savepoint would also produce that state, so the message is what
    // separates a refusal from a rollback: the pre-flight names the date whose
    // period is closed, while a failure inside the contra reports
    // postJournalEntry's own 'Cannot post to closed fiscal period'.
    const message = (result.state.body as { error?: string; message?: string } | undefined);
    expect(JSON.stringify(message)).toMatch(/fiscal period covering \d{4}-\d{2}-\d{2} is not open \(closed or locked\)/);
  });
});
