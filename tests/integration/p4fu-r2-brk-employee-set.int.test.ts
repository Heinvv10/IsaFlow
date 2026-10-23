/**
 * PAYE 4a follow-ups round 2, R1, breaker round 1 (ported from
 * .brkR2A/p4fu-brk-r2a-employee-set): the later-month half of the stale
 * year-to-date gate was judged per RUN ("was February approved when January
 * was calculated?"), but PAYE_LATER_PERIODS_APPROVED is written per EMPLOYEE,
 * only for employees on February's lines at that moment, naming the later
 * months, and only on lines taxed from the tables. The gate now reads the
 * warning off this run's lines, per employee both runs pay from the tables.
 *
 * Cases 1-2 are the breaker's repros. 3: the warning must name THAT month.
 * 4: an employee paid only untaxed amounts never carries the warning, so must
 * not be required to (else a refusal no recalculation clears). 5-6: named
 * limits (judgeYearToDateStale's comment): a run calculated before cumulative
 * PAYE (lines with no periodic_taxable, migration 913) read no year-to-date.
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

describe('R1 breaker 1: the later-month warning is per employee and per month', () => {
  it('February recalculated with an employee its first approval lacked: January is refused (that employee\'s line carries no warning)', async () => {
    const f = await seedEmployee(pool, fixtures, 'BRK R2A employee set', 20_000);
    const y = await secondEmployee(f);
    for (const p of PERIODS.slice(0, 10)) { const id = await mk(f, p.year, p.month); await calcOnly(f, id); ok(await approveRun(f, id)); }

    await pool.query("UPDATE payroll_employees SET status = 'inactive' WHERE id = $1", [y]);
    const feb = await mk(f, 2027, 2);
    await calcOnly(f, feb); // X only
    ok(await approveRun(f, feb));

    await pool.query("UPDATE payroll_employees SET status = 'active' WHERE id = $1", [y]);
    const jan = await mk(f, 2027, 1);
    await calcOnly(f, jan); // February approved: X warned; Y is not on February's lines, so Y is not
    expect(await warningCodes(jan, f.employee)).toContain('PAYE_LATER_PERIODS_APPROVED');
    expect(await warningCodes(jan, y)).not.toContain('PAYE_LATER_PERIODS_APPROVED');

    ok(await reopenRun(f, feb));
    const journal = String((await pool.query('SELECT journal_entry_id FROM payroll_run_headers WHERE id = $1', [feb])).rows[0]!.journal_entry_id);
    ok(await f.call(jeAction as Route, 'POST', '/api/accounting/journal-entries-action', undefined, { body: { id: journal, action: 'reverse' } }));
    await calcOnly(f, feb); // now with Y; January not approved, so Y's February PAYE leaves January out
    expect(await runLine(pool, feb, y)).toBeDefined();
    ok(await approveRun(f, feb));

    // February's PAYE for Y missed January and Y's January line does not say so.
    const r = await approveRun(f, jan);
    expect(r.statusCode, JSON.stringify(r.body).slice(0, 300)).toBe(400);
  });

  it('a line written before the warning existed (pre-G4 calculation, February already approved): January is refused, its line carries no warning', async () => {
    const f = await seedEmployee(pool, fixtures, 'BRK R2A legacy line', 20_000);
    for (const p of PERIODS.slice(0, 10)) { const id = await mk(f, p.year, p.month); await calcOnly(f, id); ok(await approveRun(f, id)); }
    const feb = await mk(f, 2027, 2);
    await calcOnly(f, feb);
    ok(await approveRun(f, feb));
    const jan = await mk(f, 2027, 1);
    await calcOnly(f, jan);
    // As a line calculated before PAYE_LATER_PERIODS_APPROVED existed: February approved before it, no warning on it.
    await pool.query(
      `UPDATE payroll_run_lines SET validation_results = '[]'::jsonb WHERE run_id = $1`, [jan]);
    expect(await warningCodes(jan, f.employee)).not.toContain('PAYE_LATER_PERIODS_APPROVED');
    const r = await approveRun(f, jan);
    expect(r.statusCode, JSON.stringify(r.body).slice(0, 300)).toBe(400);
  });

  it('January\'s warning names only an earlier later month (2027-01 on December), February calculated without December: December is refused until recalculated', async () => {
    const f = await seedEmployee(pool, fixtures, 'R1 warning names another month', 20_000);
    for (const p of PERIODS.slice(0, 9)) { const id = await mk(f, p.year, p.month); await calcOnly(f, id); ok(await approveRun(f, id)); }
    const jan = await mk(f, 2027, 1);
    await calcOnly(f, jan);
    ok(await approveRun(f, jan)); // December back-filled later
    const dec = await mk(f, 2026, 12);
    await calcOnly(f, dec); // warned of 2027-01 only
    const feb = await mk(f, 2027, 2);
    await calcOnly(f, feb); // December not approved: February leaves it out
    ok(await approveRun(f, feb));
    const msg = ((await runLine(pool, dec, f.employee)).validation_results as Array<{ code: string; message: string }>)
      .find(c => c.code === 'PAYE_LATER_PERIODS_APPROVED')?.message;
    expect(msg).toMatch(/2027-01/);
    expect(msg).not.toMatch(/2027-02/);
    const refused = await approveRun(f, dec);
    expect(refused.statusCode).toBe(400);
    expect(JSON.stringify(refused.body)).toMatch(/later month.*2027-02.*Recalculate the run/);
    await calcOnly(f, dec);
    ok(await approveRun(f, dec));
  });

  it('an employee paid only an untaxed allowance on both runs carries no warning and is not required to: January is approved', async () => {
    const f = await seedEmployee(pool, fixtures, 'R1 untaxed employee', 20_000);
    const z = String((await pool.query(
      `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date, date_of_birth, tax_number)
       VALUES ($1, 'R1-Z', 'Zola', 'Untaxed', '2020-01-01', '1980-01-01', '0123456787') RETURNING id`, [f.company])).rows[0]!.id);
    const allowance = String((await pool.query(
      `INSERT INTO payroll_components (company_id, name, sars_source_code, component_type, is_taxable)
       VALUES ($1, 'Untaxed allowance', '3702', 'earning', false) RETURNING id`, [f.company])).rows[0]!.id);
    await pool.query(
      `INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from) VALUES ($1, $2, 1500, '2020-01-01')`, [z, allowance]);
    for (const p of PERIODS.slice(0, 10)) { const id = await mk(f, p.year, p.month); await calcOnly(f, id); ok(await approveRun(f, id)); }
    const feb = await mk(f, 2027, 2);
    await calcOnly(f, feb);
    ok(await approveRun(f, feb));
    const jan = await mk(f, 2027, 1);
    await calcOnly(f, jan);
    expect(await warningCodes(jan, f.employee)).toContain('PAYE_LATER_PERIODS_APPROVED');
    expect(await runLine(pool, feb, z)).toBeDefined();
    expect(await warningCodes(jan, z)).not.toContain('PAYE_LATER_PERIODS_APPROVED');
    ok(await approveRun(f, jan));
  });

  // Named limits, pinned so a change to them is deliberate (judgeYearToDateStale's comment, the module .claude.md).
  const asPreCumulative = (runId: string) => pool.query(
    `UPDATE payroll_run_lines SET periodic_taxable = NULL, annual_taxable = NULL, validation_results = '[]'::jsonb WHERE run_id = $1`, [runId]);

  it('NAMED LIMIT (b): a run calculated before cumulative PAYE, every earlier month approved before it, is approved with the PAYE it has', async () => {
    const f = await seedEmployee(pool, fixtures, 'R1 limit pre-G4 run', 20_000);
    for (const p of PERIODS.slice(0, 9)) { const id = await mk(f, p.year, p.month); await calcOnly(f, id); ok(await approveRun(f, id)); }
    const dec = await mk(f, 2026, 12);
    await calcOnly(f, dec);
    await asPreCumulative(dec);
    ok(await approveRun(f, dec));
  });

  it('NAMED LIMIT (a): an earlier month approved before migration 718 (approved_at NULL) counts as approved before a pre-cumulative run was calculated', async () => {
    const f = await seedEmployee(pool, fixtures, 'R1 limit pre-718 earlier', 20_000);
    for (const p of PERIODS.slice(0, 8)) { const id = await mk(f, p.year, p.month); await calcOnly(f, id); ok(await approveRun(f, id)); }
    const nov = await mk(f, 2026, 11);
    const dec = await mk(f, 2026, 12);
    await calcOnly(f, nov);
    await calcOnly(f, dec); // November not approved yet
    await asPreCumulative(dec);
    ok(await approveRun(f, nov));
    // A NULL approved_at is an approval from before 718, so before 913: a run that missed it was calculated before 913 too.
    await pool.query('UPDATE payroll_run_headers SET approved_at = NULL WHERE id = $1', [nov]);
    ok(await approveRun(f, dec));
  });
});
