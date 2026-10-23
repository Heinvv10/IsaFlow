/**
 * PAYE 4a follow-ups round 2, R1: the stale year-to-date gate
 * (paye_year_to_date_stale) refuses exactly when this run's PAYE missed an
 * earlier month, or a later month missed this one and this run's lines lack
 * PAYE_LATER_PERIODS_APPROVED. "Missed": that month, as it now stands, was not
 * approved when the other was calculated. Read from approved_at, the approval
 * periods reopens ended (payroll_run_headers.approval_history, migration 925)
 * and the lines' created_at.
 *
 * The first sequence is why the last reopen alone (reopened_at) is not enough:
 * December reopened TWICE, January calculated during the first reopen. The
 * last reopen is after January's calculation, so "approved then" reads true
 * unless the earlier gap is kept too.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import type { Route } from './w3-01-payroll.helpers';
import createRun from '../../pages/api/payroll/runs';
import calculate from '../../pages/api/payroll/runs/[id]/calculate';
import {
  approveRun, previewRun, reopenRun, cleanSeveranceFixtures, runLine, type SeveranceFixture,
} from './p3-severance.helpers';
import { PERIODS, seedEmployee, setSalary } from './p4fu-cumulative.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const fixtures: SeveranceFixture[] = [];

beforeAll(async () => { await pool.query('SELECT 1'); });
afterAll(async () => {
  try { await cleanSeveranceFixtures(pool, fixtures); } finally { await pool.end(); }
});

async function mk(f: SeveranceFixture, year: number, month: number): Promise<string> {
  const made = await f.call(createRun as Route, 'POST', '/api/payroll/runs', undefined, { body: { month, year } });
  if (made.statusCode !== 201) throw new Error(`create: ${made.statusCode}`);
  return String(made.body.data!.id);
}
async function calcOnly(f: SeveranceFixture, id: string) {
  const calc = await f.call(calculate as Route, 'POST', `/api/payroll/runs/${id}/calculate`, id);
  if (calc.statusCode !== 200) throw new Error(`calc ${calc.statusCode}`);
}
/** Runs for the first `n` months of tax year 2027, each calculated and approved in order. */
async function approvedMonths(f: SeveranceFixture, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (const p of PERIODS.slice(0, n)) {
    const id = await mk(f, p.year, p.month);
    await calcOnly(f, id);
    expect((await approveRun(f, id)).statusCode).toBe(200);
    ids.push(id);
  }
  return ids;
}
const ok = (r: { statusCode: number; body: unknown }) => expect(r.statusCode, JSON.stringify(r.body).slice(0, 300)).toBe(200);
/** The approval preview answers 200 with no blocker at all: nothing the gate (stale year-to-date or any other) refuses. */
async function previewClear(f: SeveranceFixture, id: string) {
  const r = await previewRun(f, id);
  expect(r.statusCode, JSON.stringify(r.body).slice(0, 300)).toBe(200);
  expect(r.body.data?.planHash, 'a preview with a plan').toEqual(expect.any(String));
  expect(r.body.data?.blocker, JSON.stringify(r.body.data?.blocker)).toBeNull();
}
const warningCodes = async (runId: string, employee: string) =>
  ((await runLine(pool, runId, employee)).validation_results as Array<{ code: string }>).map(c => c.code);

describe('R1: the exact stale year-to-date gate', () => {
  it('January calculated while December was reopened, December re-approved, reopened and re-approved again: January is refused (the last reopen alone would pass it)', async () => {
    const f = await seedEmployee(pool, fixtures, 'R1 two reopens', 20_000);
    await setSalary(pool, f, 2026, 12, 60_000);
    await setSalary(pool, f, 2027, 1, 20_000);
    const ids = await approvedMonths(f, 10);
    const dec = ids[9]!;
    const jan = await mk(f, 2027, 1);
    ok(await reopenRun(f, dec));
    await calcOnly(f, jan); // December is not declarable: January's PAYE leaves it out
    ok(await approveRun(f, dec));
    ok(await reopenRun(f, dec));
    ok(await approveRun(f, dec));
    const missed = (await runLine(pool, jan, f.employee)).paye;
    const refused = await approveRun(f, jan);
    expect(refused.statusCode).toBe(400);
    expect(JSON.stringify(refused.body)).toMatch(/earlier month.*2026-12.*Recalculate the run/);
    await calcOnly(f, jan);
    // December's R60 000 is in January's year-to-date now: the refused figure really had missed it.
    expect((await runLine(pool, jan, f.employee)).paye).not.toBe(missed);
    ok(await approveRun(f, jan));
  });

  it('January calculated while December was approved, December reopened and re-approved unchanged: January is approved; the reopen recorded the approval it ended', async () => {
    const f = await seedEmployee(pool, fixtures, 'R1 seen then reopened', 20_000);
    const ids = await approvedMonths(f, 10);
    const dec = ids[9]!;
    const jan = await mk(f, 2027, 1);
    await calcOnly(f, jan);
    // As text: a JS Date drops the microseconds, and could fall before the range's lower bound.
    const before = (await pool.query('SELECT approved_at::text AS approved_at FROM payroll_run_headers WHERE id = $1', [dec])).rows[0]!;
    ok(await reopenRun(f, dec));
    const reopened = (await pool.query(
      `SELECT reopened_at, approved_at, approval_history @> $2::timestamptz AS kept,
              upper(approval_history) = reopened_at AS ends_at_reopen
         FROM payroll_run_headers WHERE id = $1`, [dec, before.approved_at])).rows[0]!;
    expect(reopened.reopened_at).not.toBeNull();
    expect(reopened.approved_at).toBeNull();
    expect(reopened.kept).toBe(true);
    expect(reopened.ends_at_reopen).toBe(true);
    ok(await approveRun(f, dec));
    ok(await approveRun(f, jan));
  });

  it('January reopened, February calculated, January recalculated, February approved: January is refused (February missed it, no warning), then warned and approved', async () => {
    const f = await seedEmployee(pool, fixtures, 'R1 later missed', 20_000);
    const ids = await approvedMonths(f, 11);
    const jan = ids[10]!;
    ok(await reopenRun(f, jan));
    const feb = await mk(f, 2027, 2);
    await calcOnly(f, feb); // January is not declarable: February's PAYE leaves it out
    await calcOnly(f, jan); // February is not approved: no warning on January
    ok(await approveRun(f, feb));
    expect(await warningCodes(jan, f.employee)).not.toContain('PAYE_LATER_PERIODS_APPROVED');
    const refused = await approveRun(f, jan);
    expect(refused.statusCode).toBe(400);
    expect(JSON.stringify(refused.body)).toMatch(/later month.*2027-02.*Recalculate the run/);
    await calcOnly(f, jan);
    expect(await warningCodes(jan, f.employee)).toContain('PAYE_LATER_PERIODS_APPROVED');
    ok(await approveRun(f, jan));
  });

  it('December reopened and RECALCULATED after January was calculated: January is refused (December\'s lines are newer than what it read)', async () => {
    const f = await seedEmployee(pool, fixtures, 'R1 earlier recalculated', 20_000);
    const ids = await approvedMonths(f, 10);
    const dec = ids[9]!;
    const jan = await mk(f, 2027, 1);
    await calcOnly(f, jan);
    ok(await reopenRun(f, dec));
    await calcOnly(f, dec);
    ok(await approveRun(f, dec));
    const refused = await approveRun(f, jan);
    expect(refused.statusCode).toBe(400);
    expect(JSON.stringify(refused.body)).toMatch(/earlier month.*2026-12.*Recalculate the run/);
    await calcOnly(f, jan);
    ok(await approveRun(f, jan));
  });

  it('a later month calculated while this run was approved, this run reopened and re-approved unchanged after it: approved (the later month saw it)', async () => {
    const f = await seedEmployee(pool, fixtures, 'R1 later saw it', 20_000);
    const ids = await approvedMonths(f, 11);
    const jan = ids[10]!;
    const feb = await mk(f, 2027, 2);
    await calcOnly(f, feb);
    ok(await reopenRun(f, jan));
    ok(await approveRun(f, feb)); // January is not approved now, but was when February was calculated
    ok(await approveRun(f, jan));
  });
  it('December reopened and re-approved TWICE after January was calculated: January is approved (the first approval period still covers it)', async () => {
    const f = await seedEmployee(pool, fixtures, 'R1 two reopens after', 20_000);
    const ids = await approvedMonths(f, 10);
    const dec = ids[9]!;
    const jan = await mk(f, 2027, 1);
    await calcOnly(f, jan);
    for (let i = 0; i < 2; i++) { ok(await reopenRun(f, dec)); ok(await approveRun(f, dec)); }
    ok(await approveRun(f, jan));
  });

  it('an earlier month approved before migration 718 (approved_at NULL) counts as approved all along, also once reopened', async () => {
    const f = await seedEmployee(pool, fixtures, 'R1 pre-718 approval', 20_000);
    const ids = await approvedMonths(f, 9);
    const nov = ids[8]!;
    const dec = await mk(f, 2026, 12);
    await calcOnly(f, dec);
    await pool.query('UPDATE payroll_run_headers SET approved_at = NULL WHERE id = $1', [nov]);
    await previewClear(f, dec);
    ok(await reopenRun(f, nov)); // ends an approval with no start: (-infinity, reopened_at)
    ok(await approveRun(f, nov));
    ok(await approveRun(f, dec));
  });

  it('a stranded approved run (no journal, before K-079) re-approved after a later month saw it: not refused as stale', async () => {
    const f = await seedEmployee(pool, fixtures, 'R1 stranded approved', 20_000);
    const ids = await approvedMonths(f, 3);
    const apr = ids[1]!;
    // Stranded: status approved, journal never linked (what K-079 left behind). The gate is judged by the preview only.
    await pool.query('UPDATE payroll_run_headers SET journal_entry_id = NULL WHERE id = $1', [apr]);
    await previewClear(f, apr);
  });

  it('February approved first, January calculated (warned), February reopened, recalculated and re-approved: January is approved (its lines still warn of February)', async () => {
    const f = await seedEmployee(pool, fixtures, 'R1 later reopened after warning', 20_000);
    await approvedMonths(f, 10);
    const feb = await mk(f, 2027, 2);
    await calcOnly(f, feb);
    ok(await approveRun(f, feb)); // January back-filled later
    const jan = await mk(f, 2027, 1);
    await calcOnly(f, jan);
    expect(await warningCodes(jan, f.employee)).toContain('PAYE_LATER_PERIODS_APPROVED');
    ok(await reopenRun(f, feb));
    await calcOnly(f, feb); // January is not approved: February still leaves it out, as the warning says
    ok(await approveRun(f, feb));
    ok(await approveRun(f, jan));
  });
  it('February calculated while January was approved, January reopened and RECALCULATED, February approved: January is refused (February read its earlier lines)', async () => {
    const f = await seedEmployee(pool, fixtures, 'R1 later read older lines', 20_000);
    const ids = await approvedMonths(f, 11);
    const jan = ids[10]!;
    const feb = await mk(f, 2027, 2);
    await calcOnly(f, feb);
    ok(await reopenRun(f, jan));
    await calcOnly(f, jan); // February is not approved: no warning
    ok(await approveRun(f, feb));
    const refused = await approveRun(f, jan);
    expect(refused.statusCode).toBe(400);
    expect(JSON.stringify(refused.body)).toMatch(/later month.*2027-02.*Recalculate the run/);
  });

  it('a later month approved before migration 718 (approved_at NULL) warns this run all along: approved', async () => {
    const f = await seedEmployee(pool, fixtures, 'R1 pre-718 later month', 20_000);
    await approvedMonths(f, 10);
    const feb = await mk(f, 2027, 2);
    await calcOnly(f, feb);
    ok(await approveRun(f, feb));
    await pool.query('UPDATE payroll_run_headers SET approved_at = NULL WHERE id = $1', [feb]);
    const jan = await mk(f, 2027, 1);
    await calcOnly(f, jan);
    expect(await warningCodes(jan, f.employee)).toContain('PAYE_LATER_PERIODS_APPROVED');
    ok(await approveRun(f, jan));
  });

  it('a reopen after the clock stepped back past approved_at still reopens; that approval is not kept (the gate then refuses conservatively)', async () => {
    const f = await seedEmployee(pool, fixtures, 'R1 clock step back', 20_000);
    const ids = await approvedMonths(f, 10);
    const dec = ids[9]!;
    const jan = await mk(f, 2027, 1);
    await calcOnly(f, jan);
    // What a clock stepped back an hour looks like to the reopen: its approval is "in the future".
    await pool.query("UPDATE payroll_run_headers SET approved_at = clock_timestamp() + INTERVAL '1 hour' WHERE id = $1", [dec]);
    ok(await reopenRun(f, dec));
    const h = (await pool.query(
      `SELECT status, reopened_at IS NOT NULL AS reopened, COALESCE(isempty(approval_history), true) AS nothing_kept
         FROM payroll_run_headers WHERE id = $1`, [dec])).rows[0]!;
    expect(h).toEqual({ status: 'calculated', reopened: true, nothing_kept: true });
    ok(await approveRun(f, dec));
    const refused = await approveRun(f, jan);
    expect(refused.statusCode).toBe(400);
    expect(JSON.stringify(refused.body)).toMatch(/earlier month.*2026-12.*Recalculate the run/);
  });
});
