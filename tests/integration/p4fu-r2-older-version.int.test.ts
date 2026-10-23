/**
 * PAYE 4a follow-ups round 2, R1, blind review round 2: a later month that was
 * calculated from an EARLIER version of this run (this run approved then, its
 * lines since rewritten) still counts that version's figures in its
 * year-to-date. For an employee the later month pays from the tables whom this
 * run no longer pays from the tables, no warning can say so (a warning sits on
 * this run's taxed line, and there is none): the gate refuses this run, and the
 * remedy is the LATER month — reopen it, approve this run, recalculate it.
 *
 * Also pinned here: named limit (b), the earlier arm refuses a pre-cumulative
 * run like any other; and named limit (c), a later month that read this run's
 * earlier figures for an employee still taxed here passes once the warning is
 * on the line, although its PAYE counted the old figures.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import type { Route } from './w3-01-payroll.helpers';
import createRun from '../../pages/api/payroll/runs';
import calculate from '../../pages/api/payroll/runs/[id]/calculate';
import jeAction from '../../pages/api/accounting/journal-entries-action';
import { approveRun, reopenRun, cleanSeveranceFixtures, runLine, type SeveranceFixture } from './p3-severance.helpers';
import { PERIODS, seedEmployee } from './p4fu-cumulative.helpers';

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
const warningCodes = async (runId: string, employee: string) =>
  ((await runLine(pool, runId, employee)).validation_results as Array<{ code: string }>).map(c => c.code);
/** Reverse a reopened run's journal, so its changed figures post fresh on approval. */
async function reverseJournal(f: SeveranceFixture, runId: string) {
  const journal = String((await pool.query('SELECT journal_entry_id FROM payroll_run_headers WHERE id = $1', [runId])).rows[0]!.journal_entry_id);
  ok(await f.call(jeAction as Route, 'POST', '/api/accounting/journal-entries-action', undefined, { body: { id: journal, action: 'reverse' } }));
}
let seq = 0;
/** Another employee of f's company: `pay` from `from` (to `to`), taxed salary (3601) or an untaxed allowance. */
async function employee(f: SeveranceFixture, pay: 'salary' | 'allowance', from: string, to: string | null = null, start = '2020-01-01') {
  seq += 1;
  const id = String((await pool.query(
    `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date, end_date, date_of_birth, tax_number)
     VALUES ($1, $2, 'Extra', $2, $3::date, $4::date, '1980-01-01', $5) RETURNING id`,
    [f.company, `R1-OV-${seq}`, start, to, String(1234567000 + seq)])).rows[0]!.id);
  const comp = pay === 'salary'
    ? String((await pool.query("SELECT id FROM payroll_components WHERE company_id = $1 AND sars_source_code = '3601'", [f.company])).rows[0]!.id)
    : String((await pool.query(
      `INSERT INTO payroll_components (company_id, name, sars_source_code, component_type, is_taxable)
       VALUES ($1, 'Untaxed allowance ' || $2, '3702', 'earning', false) RETURNING id`, [f.company, seq])).rows[0]!.id);
  await pool.query(
    `INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from, effective_to) VALUES ($1, $2, $3, $4, $5)`,
    [id, comp, pay === 'salary' ? 20_000 : 1_500, from, to]);
  return id;
}
async function approvedThrough(f: SeveranceFixture, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (const p of PERIODS.slice(0, n)) { const id = await mk(f, p.year, p.month); await calcOnly(f, id); ok(await approveRun(f, id)); ids.push(id); }
  return ids;
}

describe('R1 review 2: a later month calculated from an earlier version of this run', () => {
  it('January recalculated so X is no longer taxed, February read the old January: January refused (remedy: February); reopening February clears it', async () => {
    const f = await seedEmployee(pool, fixtures, 'R1 older version dropped', 20_000);
    await employee(f, 'salary', '2020-01-01', '2027-01-31'); // W: paid through January, not in February
    const ids = await approvedThrough(f, 11);
    const jan = ids[10]!;
    const feb = await mk(f, 2027, 2);
    await calcOnly(f, feb); // X's year-to-date includes January's taxed X line
    const febPayeBefore = (await runLine(pool, feb, f.employee)).paye;
    ok(await reopenRun(f, jan));
    // January corrected: X was paid only an untaxed allowance that month.
    await pool.query(`UPDATE payroll_employee_components SET effective_to = '2026-12-31' WHERE employee_id = $1 AND effective_to IS NULL`, [f.employee]);
    const allowance = String((await pool.query(
      `INSERT INTO payroll_components (company_id, name, sars_source_code, component_type, is_taxable)
       VALUES ($1, 'Jan allowance', '3702', 'earning', false) RETURNING id`, [f.company])).rows[0]!.id);
    await pool.query(
      `INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from, effective_to) VALUES ($1, $2, 1500, '2027-01-01', '2027-01-31')`,
      [f.employee, allowance]);
    await pool.query(
      `INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from)
       SELECT $1, c.id, 20000, '2027-02-01' FROM payroll_components c WHERE c.company_id = $2 AND c.sars_source_code = '3601'`, [f.employee, f.company]);
    await reverseJournal(f, jan);
    await calcOnly(f, jan);
    ok(await approveRun(f, feb)); // January is not approved now: February's earlier arm does not judge it
    const refused = await approveRun(f, jan);
    expect(refused.statusCode).toBe(400);
    expect(JSON.stringify(refused.body)).toMatch(/later month.*2027-02.*earlier figures.*Reopen that month, approve this run, then recalculate/);

    // The remedy: February reopened (no longer declarable), January approved, February recalculated from it.
    ok(await reopenRun(f, feb));
    ok(await approveRun(f, jan));
    await reverseJournal(f, feb);
    await calcOnly(f, feb);
    expect((await runLine(pool, feb, f.employee)).paye).not.toBe(febPayeBefore); // February had counted January's old PAYE
    ok(await approveRun(f, feb));
  });

  it('an employee who starts in February, January back-filled after February (never seen by it): approved', async () => {
    const f = await seedEmployee(pool, fixtures, 'R1 starter never-seen', 20_000);
    await employee(f, 'salary', '2027-02-01', null, '2027-02-01');
    await approvedThrough(f, 10);
    const feb = await mk(f, 2027, 2);
    await calcOnly(f, feb);
    ok(await approveRun(f, feb));
    const jan = await mk(f, 2027, 1);
    await calcOnly(f, jan);
    ok(await approveRun(f, jan));
  });

  it('an employee who starts in February, January reopened and re-approved UNCHANGED after February was calculated: approved (February read January as it stands)', async () => {
    const f = await seedEmployee(pool, fixtures, 'R1 starter same version', 20_000);
    await employee(f, 'salary', '2027-02-01', null, '2027-02-01');
    const ids = await approvedThrough(f, 11);
    const jan = ids[10]!;
    const feb = await mk(f, 2027, 2);
    await calcOnly(f, feb);
    ok(await reopenRun(f, jan));
    ok(await approveRun(f, feb));
    ok(await approveRun(f, jan));
  });

  it('February also pays a starter only an untaxed allowance; January recalculated after February was approved (warned): approved', async () => {
    const f = await seedEmployee(pool, fixtures, 'R1 untaxed starter', 20_000);
    await employee(f, 'allowance', '2027-02-01', null, '2027-02-01');
    const ids = await approvedThrough(f, 11);
    const jan = ids[10]!;
    const feb = await mk(f, 2027, 2);
    await calcOnly(f, feb);
    ok(await approveRun(f, feb));
    ok(await reopenRun(f, jan));
    await calcOnly(f, jan); // February approved: X's January line is warned
    expect(await warningCodes(jan, f.employee)).toContain('PAYE_LATER_PERIODS_APPROVED');
    ok(await approveRun(f, jan));
  });

  it('NAMED LIMIT (b): the earlier arm judges a pre-cumulative run like any other: calculated before November was approved, December is refused', async () => {
    const f = await seedEmployee(pool, fixtures, 'R1 limit b refused', 20_000);
    await approvedThrough(f, 8);
    const nov = await mk(f, 2026, 11);
    const dec = await mk(f, 2026, 12);
    await calcOnly(f, nov);
    await calcOnly(f, dec);
    await pool.query(
      `UPDATE payroll_run_lines SET periodic_taxable = NULL, annual_taxable = NULL, validation_results = '[]'::jsonb WHERE run_id = $1`, [dec]);
    ok(await approveRun(f, nov));
    const refused = await approveRun(f, dec);
    expect(refused.statusCode).toBe(400);
    expect(JSON.stringify(refused.body)).toMatch(/earlier month.*2026-11.*Recalculate the run/);
  });

  it('NAMED LIMIT (c): January recalculated with new figures after February read the old ones, February approved meanwhile: approved once the warning is on the line', async () => {
    const f = await seedEmployee(pool, fixtures, 'R1 limit c', 20_000);
    const ids = await approvedThrough(f, 11);
    const jan = ids[10]!;
    const feb = await mk(f, 2027, 2);
    await calcOnly(f, feb); // reads January at R20 000
    ok(await approveRun(f, feb));
    ok(await reopenRun(f, jan));
    await pool.query(
      `UPDATE payroll_employee_components SET amount = 30000
        WHERE employee_id = $1 AND effective_to IS NULL`, [f.employee]); // January (and on) now R30 000
    await reverseJournal(f, jan);
    await calcOnly(f, jan);
    const warning = ((await runLine(pool, jan, f.employee)).validation_results as Array<{ code: string; periods?: string[] }>)
      .find(c => c.code === 'PAYE_LATER_PERIODS_APPROVED');
    expect(warning?.periods).toEqual(['2027-02']);
    ok(await approveRun(f, jan)); // February's PAYE still counts January at R20 000: the warning is the only signal
  });
});
