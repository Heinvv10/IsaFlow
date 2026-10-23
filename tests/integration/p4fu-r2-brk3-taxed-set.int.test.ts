/**
 * PAYE 4a follow-ups round 2, R1, breaker round 3 (ported from
 * .brkR2A/p4fu-brk3-r2a-recalc-later) and Hein's fix (2026-10-23): a reopen
 * records whom the approval it ends taxed from the tables
 * (payroll_run_headers.approved_taxed_employees, migration 925), so the
 * earlier-version arm (`recalc_later`) refuses only for an employee an earlier
 * approved version of this run taxed. A starter in a later month no longer
 * forces a reopen of every later month (case 1), while a starter date
 * "corrected" to take someone off this run still refuses (the round-2 hole).
 *
 * The set is the UNION over every closed approval, not per approval range:
 * enough for every earlier version (accumulation case), at the price of a
 * conservative refusal when the employee was taxed only in a version the later
 * month did not read (pinned). NULL with a history (reopened before the column
 * existed) stays conservative and is not turned into a set by a later reopen.
 * A PAID later month (legacy rows only) cannot be reopened, so it is not
 * judged by this arm: named limit (f).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import type { Route } from './w3-01-payroll.helpers';
import createRun from '../../pages/api/payroll/runs';
import calculate from '../../pages/api/payroll/runs/[id]/calculate';
import jeAction from '../../pages/api/accounting/journal-entries-action';
import { approveRun, previewRun, reopenRun, cleanSeveranceFixtures, runLine, type SeveranceFixture } from './p3-severance.helpers';
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
  if (calc.statusCode !== 200) throw new Error(`calc ${calc.statusCode} ${JSON.stringify(calc.body).slice(0, 300)}`);
}
const ok = (r: { statusCode: number; body: unknown }) => expect(r.statusCode, JSON.stringify(r.body).slice(0, 300)).toBe(200);
const REMEDY = /later month.*earlier figures.*Reopen that month, approve this run/;

/** A second employee of f's company, same salary component and amount as f's. */
async function secondEmployee(f: SeveranceFixture): Promise<string> {
  const y = String((await pool.query(
    `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date, date_of_birth, tax_number)
     SELECT company_id, 'BRK-Y', 'Yusuf', 'Second', start_date, date_of_birth, '0123456788'
       FROM payroll_employees WHERE id = $1 RETURNING id`, [f.employee])).rows[0]!.id);
  await pool.query(
    `INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from, effective_to)
     SELECT $2, component_id, amount, effective_from, effective_to FROM payroll_employee_components WHERE employee_id = $1`,
    [f.employee, y]);
  return y;
}
async function reverseJournal(f: SeveranceFixture, runId: string) {
  const journal = String((await pool.query('SELECT journal_entry_id FROM payroll_run_headers WHERE id = $1', [runId])).rows[0]!.journal_entry_id);
  ok(await f.call(jeAction as Route, 'POST', '/api/accounting/journal-entries-action', undefined, { body: { id: journal, action: 'reverse' } }));
}
async function approveInOrder(f: SeveranceFixture, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (const p of PERIODS.slice(0, n)) { const id = await mk(f, p.year, p.month); await calcOnly(f, id); ok(await approveRun(f, id)); ids.push(id); }
  return ids;
}
const active = (y: string, on: boolean) => pool.query('UPDATE payroll_employees SET status = $2 WHERE id = $1', [y, on ? 'active' : 'inactive']);
const taxedSet = async (runId: string) =>
  (await pool.query('SELECT approved_taxed_employees AS s FROM payroll_run_headers WHERE id = $1', [runId])).rows[0]!.s as string[] | null;

describe('R1 breaker 3: the taxed employees of each closed approval', () => {
  it('a starter in January; December reopened and recalculated UNCHANGED: December is approved (no version of December taxed them)', async () => {
    const f = await seedEmployee(pool, fixtures, 'BRK3 starter', 20_000);
    const z = await secondEmployee(f);
    await pool.query("UPDATE payroll_employees SET start_date = '2027-01-01' WHERE id = $1", [z]);
    const ids = await approveInOrder(f, 12); // Mar–Feb in order; Z paid in January and February only
    const dec = ids[9]!;
    expect(await runLine(pool, dec, z)).toBeUndefined();
    const xBefore = (await runLine(pool, dec, f.employee)).paye;
    ok(await reopenRun(f, dec));
    expect(await taxedSet(dec)).toEqual([f.employee]);
    await calcOnly(f, dec); // unchanged: approved onto its own journal, no reversal
    expect((await runLine(pool, dec, f.employee)).paye).toBe(xBefore);
    ok(await approveRun(f, dec));
  });

  it('only TAXED lines enter the set: Z paid only an untaxed allowance by December, taxed from January; December recalculated unchanged is approved', async () => {
    const f = await seedEmployee(pool, fixtures, 'BRK3 untaxed in set', 20_000);
    const z = await secondEmployee(f);
    const allowance = String((await pool.query(
      `INSERT INTO payroll_components (company_id, name, sars_source_code, component_type, is_taxable)
       VALUES ($1, 'Untaxed allowance', '3702', 'earning', false) RETURNING id`, [f.company])).rows[0]!.id);
    await pool.query(`UPDATE payroll_employee_components SET effective_from = '2027-01-01' WHERE employee_id = $1`, [z]);
    await pool.query(
      `INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from, effective_to)
       VALUES ($1, $2, 1500, '2020-01-01', '2026-12-31')`, [z, allowance]);
    const ids = await approveInOrder(f, 12);
    const dec = ids[9]!;
    expect(Number((await pool.query('SELECT periodic_taxable FROM payroll_run_lines WHERE run_id = $1 AND employee_id = $2', [dec, z])).rows[0]!.periodic_taxable)).toBe(0);
    ok(await reopenRun(f, dec));
    expect(await taxedSet(dec)).toEqual([f.employee]);
    await calcOnly(f, dec);
    ok(await approveRun(f, dec));
  });

  it('a start date "corrected" to take Y off January after February read Y\'s January: January is still refused', async () => {
    const f = await seedEmployee(pool, fixtures, 'BRK3 start-date correction', 20_000);
    const y = await secondEmployee(f);
    await setSalary(pool, { ...f, employee: y }, 2027, 1, 60_000);
    await setSalary(pool, { ...f, employee: y }, 2027, 2, 20_000);
    const ids = await approveInOrder(f, 12);
    const jan = ids[10]!;
    ok(await reopenRun(f, jan)); // records X and Y
    await pool.query("UPDATE payroll_employees SET start_date = '2027-02-01' WHERE id = $1", [y]);
    await reverseJournal(f, jan);
    await calcOnly(f, jan);
    expect(await runLine(pool, jan, y)).toBeUndefined();
    const refused = await approveRun(f, jan);
    expect(refused.statusCode).toBe(400);
    expect(JSON.stringify(refused.body)).toMatch(REMEDY);
  });

  it('the set accumulates: Y taxed only in December\'s FIRST approval, which January read, is still refused for after a second reopen', async () => {
    const f = await seedEmployee(pool, fixtures, 'BRK3 accumulates', 20_000);
    const y = await secondEmployee(f);
    const ids = await approveInOrder(f, 10);
    const dec = ids[9]!;
    const jan = await mk(f, 2027, 1);
    await calcOnly(f, jan); // reads December v1: X and Y taxed
    ok(await reopenRun(f, dec));
    await active(y, false);
    await reverseJournal(f, dec);
    await calcOnly(f, dec); // v2: X only
    ok(await approveRun(f, dec)); // January not approved: nothing judges it yet
    ok(await reopenRun(f, dec)); // ends v2, which taxed X only
    expect([...(await taxedSet(dec))!].sort()).toEqual([f.employee, y].sort());
    ok(await approveRun(f, jan)); // December not approved: not judged
    await calcOnly(f, dec); // v3 = v2, now with January approved: X carries the warning, so only the taxed set can refuse
    const refused = await approveRun(f, dec); // January still counts v1's Y
    expect(refused.statusCode).toBe(400);
    expect(JSON.stringify(refused.body)).toMatch(REMEDY);
    expect(JSON.stringify(refused.body)).not.toMatch(/Recalculate the run/);
  });

  it('CONSERVATIVE (union, not per version): Y taxed only in a version January did NOT read still refuses; the remedy clears it', async () => {
    const f = await seedEmployee(pool, fixtures, 'BRK3 union conservative', 20_000);
    const y = await secondEmployee(f);
    const ids = await approveInOrder(f, 10);
    const dec = ids[9]!;
    ok(await reopenRun(f, dec)); // ends v1: X and Y
    await active(y, false);
    await reverseJournal(f, dec);
    await calcOnly(f, dec); // v2: X only
    ok(await approveRun(f, dec));
    await active(y, true);
    const jan = await mk(f, 2027, 1);
    await calcOnly(f, jan); // reads v2: no Y in December
    ok(await approveRun(f, jan));
    ok(await reopenRun(f, dec)); // ends v2
    await active(y, false);
    await calcOnly(f, dec); // v3 = v2
    await active(y, true);
    const refused = await approveRun(f, dec);
    expect(refused.statusCode).toBe(400);
    expect(JSON.stringify(refused.body)).toMatch(REMEDY);
    expect(JSON.stringify(refused.body)).not.toMatch(/Recalculate the run/);
    // The remedy: January reopened, December approved, January recalculated (unchanged, so no reversal) and approved.
    ok(await reopenRun(f, jan));
    ok(await approveRun(f, dec));
    await calcOnly(f, jan);
    ok(await approveRun(f, jan));
  });

  it('January read December AS IT STANDS (v2); December reopened and re-approved unchanged: approved, though the set still holds Y from v1', async () => {
    const f = await seedEmployee(pool, fixtures, 'BRK3 same version, old Y', 20_000);
    const y = await secondEmployee(f);
    const ids = await approveInOrder(f, 10);
    const dec = ids[9]!;
    ok(await reopenRun(f, dec)); // ends v1: X and Y
    await active(y, false);
    await reverseJournal(f, dec);
    await calcOnly(f, dec); // v2: X only
    ok(await approveRun(f, dec));
    await active(y, true);
    const jan = await mk(f, 2027, 1);
    await calcOnly(f, jan); // reads v2
    ok(await approveRun(f, jan));
    ok(await reopenRun(f, dec)); // ends v2; the set keeps Y
    ok(await approveRun(f, dec)); // v2 unchanged: January read exactly these lines
  });

  it('January pays Y only an untaxed allowance (no year-to-date bite); December recalculated without Y: approved', async () => {
    const f = await seedEmployee(pool, fixtures, 'BRK3 later untaxed, in set', 20_000);
    const y = await secondEmployee(f);
    const allowance = String((await pool.query(
      `INSERT INTO payroll_components (company_id, name, sars_source_code, component_type, is_taxable)
       VALUES ($1, 'Untaxed allowance', '3702', 'earning', false) RETURNING id`, [f.company])).rows[0]!.id);
    await pool.query(`UPDATE payroll_employee_components SET effective_to = '2026-12-31' WHERE employee_id = $1`, [y]);
    await pool.query(
      `INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from) VALUES ($1, $2, 1500, '2027-01-01')`, [y, allowance]);
    const ids = await approveInOrder(f, 11); // December v1 taxes Y; January pays Y untaxed only
    const dec = ids[9]!;
    ok(await reopenRun(f, dec)); // the set holds X and Y
    await active(y, false);
    await reverseJournal(f, dec);
    await calcOnly(f, dec); // without Y; January approved, so X is warned
    ok(await approveRun(f, dec));
  });

  it('a set unknown because the run was reopened before the column existed (NULL with a history) is conservative, and a later reopen keeps it unknown', async () => {
    const f = await seedEmployee(pool, fixtures, 'BRK3 null set', 20_000);
    const z = await secondEmployee(f);
    await pool.query("UPDATE payroll_employees SET start_date = '2027-01-01' WHERE id = $1", [z]);
    const ids = await approveInOrder(f, 12);
    const dec = ids[9]!;
    ok(await reopenRun(f, dec));
    await pool.query('UPDATE payroll_run_headers SET approved_taxed_employees = NULL WHERE id = $1', [dec]);
    await calcOnly(f, dec);
    const refused = await approveRun(f, dec); // the starter Z: whom the old version taxed is unknown
    expect(refused.statusCode).toBe(400);
    expect(JSON.stringify(refused.body)).toMatch(REMEDY);
    ok(await reopenRun(f, ids[10]!)); ok(await reopenRun(f, ids[11]!));
    ok(await approveRun(f, dec));
    ok(await reopenRun(f, dec));
    expect(await taxedSet(dec)).toBeNull();
  });

  it('NAMED LIMIT (f): a PAID later month (legacy rows) cannot be reopened, so it is not refused for: January is approved, with an advisory naming it', async () => {
    const f = await seedEmployee(pool, fixtures, 'BRK3 paid later', 20_000);
    const y = await secondEmployee(f);
    await setSalary(pool, { ...f, employee: y }, 2027, 1, 60_000);
    await setSalary(pool, { ...f, employee: y }, 2027, 2, 20_000);
    const ids = await approveInOrder(f, 12);
    const jan = ids[10]!; const feb = ids[11]!;
    await pool.query("UPDATE payroll_run_headers SET status = 'paid' WHERE id = $1", [feb]);
    ok(await reopenRun(f, jan));
    await reverseJournal(f, jan);
    await active(y, false);
    await calcOnly(f, jan);
    expect((await reopenRun(f, feb)).statusCode).toBe(400); // the remedy is not available for a paid month
    const preview = await previewRun(f, jan);
    expect(preview.body.data?.blocker ?? null).toBeNull();
    const advisory = (preview.body.data?.plan?.advisories as Array<{ code: string; detail: string }>)
      .find(a => a.code === 'paye_paid_later_month_stale');
    expect(advisory?.detail).toMatch(/2027-02.*paid.*cannot be reopened/);
    ok(await approveRun(f, jan)); // February keeps counting Y's old January PAYE: the limit, said out loud
  });
});
