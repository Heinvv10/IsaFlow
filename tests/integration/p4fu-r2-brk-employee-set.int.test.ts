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

  /** January reopened, February calculated while it was (missing it), January recalculated (no warning), February approved. */
  async function febMissedJan(name: string, beforeFeb?: (f: SeveranceFixture) => Promise<void>) {
    const f = await seedEmployee(pool, fixtures, name, 20_000);
    const ids: string[] = [];
    for (const p of PERIODS.slice(0, 11)) { const id = await mk(f, p.year, p.month); await calcOnly(f, id); ok(await approveRun(f, id)); ids.push(id); }
    const jan = ids[10]!;
    ok(await reopenRun(f, jan));
    await beforeFeb?.(f);
    const feb = await mk(f, 2027, 2);
    await calcOnly(f, feb);
    await calcOnly(f, jan);
    ok(await approveRun(f, feb));
    return { f, jan, feb };
  }

  it('February pays the shared employee only untaxed amounts: it read no year-to-date for them, so January is approved', async () => {
    const { f, jan, feb } = await febMissedJan('R1 later month untaxed', async (f) => {
      // From February the employee's salary stops and an untaxed allowance is all February pays them.
      await pool.query(
        `UPDATE payroll_employee_components SET effective_to = '2027-01-31' WHERE employee_id = $1 AND effective_to IS NULL`, [f.employee]);
      const allowance = String((await pool.query(
        `INSERT INTO payroll_components (company_id, name, sars_source_code, component_type, is_taxable)
         VALUES ($1, 'Untaxed allowance', '3702', 'earning', false) RETURNING id`, [f.company])).rows[0]!.id);
      await pool.query(
        `INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from) VALUES ($1, $2, 1500, '2027-02-01')`,
        [f.employee, allowance]);
    });
    const febLine = (await pool.query(
      'SELECT periodic_taxable::float8 AS p, annual_taxable::float8 AS a FROM payroll_run_lines WHERE run_id = $1 AND employee_id = $2',
      [feb, f.employee])).rows[0];
    expect(febLine).toEqual({ p: 0, a: 0 }); // on February's lines, nothing taxed from the tables
    expect(await warningCodes(jan, f.employee)).not.toContain('PAYE_LATER_PERIODS_APPROVED');
    ok(await approveRun(f, jan));
  });

  it('February\'s lines from before cumulative PAYE (no periodic_taxable) read no year-to-date: January is approved', async () => {
    const { f, jan, feb } = await febMissedJan('R1 later month pre-cumulative');
    await pool.query('UPDATE payroll_run_lines SET periodic_taxable = NULL, annual_taxable = NULL WHERE run_id = $1', [feb]);
    ok(await approveRun(f, jan));
  });

  it('a pre-cumulative January line (no periodic_taxable, no warning) that a cumulative February missed: January is refused', async () => {
    const { f, jan } = await febMissedJan('R1 this run pre-cumulative');
    await pool.query(
      `UPDATE payroll_run_lines SET periodic_taxable = NULL, annual_taxable = NULL, validation_results = '[]'::jsonb WHERE run_id = $1`, [jan]);
    const refused = await approveRun(f, jan);
    expect(refused.statusCode).toBe(400);
    expect(JSON.stringify(refused.body)).toMatch(/later month.*2027-02.*Recalculate the run/);
  });

  it('a legacy validation_results that is not an array reads as no warning: refused, not a 500', async () => {
    const { f, jan } = await febMissedJan('R1 legacy validation shape');
    await pool.query(`UPDATE payroll_run_lines SET validation_results = '{}'::jsonb WHERE run_id = $1`, [jan]);
    const refused = await approveRun(f, jan);
    expect(refused.statusCode, JSON.stringify(refused.body).slice(0, 200)).toBe(400);
    expect(JSON.stringify(refused.body)).toMatch(/later month.*2027-02/);
  });

  it('an employee untaxed in January (no warning written) but taxed in February: January\'s untaxed line added nothing February missed, so January is approved', async () => {
    const f = await seedEmployee(pool, fixtures, 'R1 untaxed this month only', 20_000);
    const z = String((await pool.query(
      `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date, date_of_birth, tax_number)
       VALUES ($1, 'R1-Z2', 'Zane', 'Starter', '2027-01-01', '1980-01-01', '0123456786') RETURNING id`, [f.company])).rows[0]!.id);
    const allowance = String((await pool.query(
      `INSERT INTO payroll_components (company_id, name, sars_source_code, component_type, is_taxable)
       VALUES ($1, 'Untaxed allowance', '3702', 'earning', false) RETURNING id`, [f.company])).rows[0]!.id);
    await pool.query(
      `INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from, effective_to)
       VALUES ($1, $2, 1500, '2027-01-01', '2027-01-31')`, [z, allowance]);
    await pool.query(
      `INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from)
       SELECT $1, c.id, 20000, '2027-02-01' FROM payroll_components c WHERE c.company_id = $2 AND c.sars_source_code = '3601'`,
      [z, f.company]);
    for (const p of PERIODS.slice(0, 10)) { const id = await mk(f, p.year, p.month); await calcOnly(f, id); ok(await approveRun(f, id)); }
    const feb = await mk(f, 2027, 2);
    await calcOnly(f, feb);
    ok(await approveRun(f, feb));
    const jan = await mk(f, 2027, 1);
    await calcOnly(f, jan); // February approved: the taxed employee is warned; the untaxed line is not
    expect(await warningCodes(jan, f.employee)).toContain('PAYE_LATER_PERIODS_APPROVED');
    expect(await warningCodes(jan, z)).not.toContain('PAYE_LATER_PERIODS_APPROVED');
    expect(Number((await pool.query(
      'SELECT periodic_taxable FROM payroll_run_lines WHERE run_id = $1 AND employee_id = $2', [feb, z])).rows[0]!.periodic_taxable)).toBeGreaterThan(0);
    ok(await approveRun(f, jan));
  });

  it('only PAYE_LATER_PERIODS_APPROVED counts: another validation naming 2027-02 does not stand in for it', async () => {
    const { f, jan } = await febMissedJan('R1 other validation names month');
    await pool.query(
      `UPDATE payroll_run_lines SET validation_results = $2::jsonb WHERE run_id = $1`,
      [jan, JSON.stringify([{ code: 'SOME_OTHER_NOTE', severity: 'warning', message: 'See the 2027-02 run.' }])]);
    const refused = await approveRun(f, jan);
    expect(refused.statusCode).toBe(400);
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
