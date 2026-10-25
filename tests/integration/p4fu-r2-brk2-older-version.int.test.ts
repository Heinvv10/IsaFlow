/**
 * PAYE 4a follow-ups round 2, R1, breaker round 2 (ported from
 * .brkR2A/p4fu-brk2-r2a-older-version): February read an EARLIER APPROVED
 * version of January (January approved when February was calculated, then
 * reopened and recalculated). An employee taxed in that old version and
 * absent (case 1) or untaxed (case 2) in the new one is in February's
 * year-to-date with figures that no longer exist, and no warning can sit on a
 * line January does not have, or does not tax. January is refused
 * (`recalc_later`); the remedy is February: reopen it, approve January,
 * recalculate it. The harm, measured: February's PAYE for Y changes once it is
 * recalculated on January as it stands.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import type { Route } from './w3-01-payroll.helpers';
import createRun from '../../pages/api/payroll/runs';
import calculate from '../../pages/api/payroll/runs/[id]/calculate';
import jeAction from '../../pages/api/accounting/journal-entries-action';
import { approveRun, reopenRun, cleanSeveranceFixtures, runLine, type SeveranceFixture } from './p3-severance.helpers';
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

/** A second employee of f's company, same salary component and amount as f's. */
async function secondEmployee(f: SeveranceFixture): Promise<string> {
  const y = String((await pool.query(
    `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date, date_of_birth, tax_number, medical_aid_main_member)
     SELECT company_id, 'BRK-Y', 'Yusuf', 'Second', start_date, date_of_birth, '0123456788', medical_aid_main_member
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

/** Mar–Dec approved for X and Y; Y earns `janY` in January only. January then February calculated and approved in order. */
async function yearThroughFeb(name: string, janY: number) {
  const f = await seedEmployee(pool, fixtures, name, 20_000);
  const y = await secondEmployee(f);
  const fy = { ...f, employee: y };
  await setSalary(pool, fy, 2027, 1, janY);
  await setSalary(pool, fy, 2027, 2, 20_000);
  for (const p of PERIODS.slice(0, 10)) { const id = await mk(f, p.year, p.month); await calcOnly(f, id); ok(await approveRun(f, id)); }
  const jan = await mk(f, 2027, 1);
  await calcOnly(f, jan);
  ok(await approveRun(f, jan));
  const feb = await mk(f, 2027, 2);
  await calcOnly(f, feb); // reads January (approved) as it stood: Y taxed on janY
  ok(await approveRun(f, feb));
  return { f, y, fy, jan, feb };
}

/** The remedy, then February's PAYE for `employee` before and after: reopen February, approve January, recalculate February on it. */
async function remedy(f: SeveranceFixture, jan: string, feb: string, employee: string) {
  const stale = (await runLine(pool, feb, employee)).paye as number;
  ok(await reopenRun(f, feb));
  ok(await approveRun(f, jan)); // February no longer approved: nothing left to refuse January for
  await calcOnly(f, feb);
  // February's figures changed: approval refuses them onto its old journal and says to reverse it first.
  const onOld = await approveRun(f, feb);
  expect(onOld.statusCode).toBe(400);
  expect(JSON.stringify(onOld.body)).toMatch(/Reverse journal .* first/);
  await reverseJournal(f, feb);
  ok(await approveRun(f, feb));
  return { stale, current: (await runLine(pool, feb, employee)).paye as number };
}

const REMEDY = /later month.*2027-02.*earlier figures.*Reopen that month, approve this run/;

describe('R1 breaker 2: the later month read an older approved version of this run', () => {
  it('Y removed from January after February read it: January is refused (February credited a January PAYE for Y that no longer exists)', async () => {
    const { f, y, jan, feb } = await yearThroughFeb('BRK2 Y removed', 60_000);
    ok(await reopenRun(f, jan));
    await reverseJournal(f, jan);
    await pool.query("UPDATE payroll_employees SET status = 'inactive' WHERE id = $1", [y]);
    await calcOnly(f, jan); // X only; X warned of February
    expect(await runLine(pool, jan, y)).toBeUndefined();
    const r = await approveRun(f, jan);
    expect(r.statusCode, JSON.stringify(r.body).slice(0, 300)).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(REMEDY);
    // The harm: February's PAYE for Y, recalculated on January as it now stands, is different.
    await pool.query("UPDATE payroll_employees SET status = 'active' WHERE id = $1", [y]);
    const { stale, current } = await remedy(f, jan, feb, y);
    expect(stale, `Feb PAYE for Y: ${stale} as approved, ${current} on January as it stands`).not.toBe(current);
  });

  it('Y untaxed in January after February read it taxed: January is refused', async () => {
    const { f, y, fy, jan, feb } = await yearThroughFeb('BRK2 Y untaxed', 60_000);
    ok(await reopenRun(f, jan));
    await reverseJournal(f, jan);
    await pool.query('UPDATE payroll_employee_components SET amount = 0 WHERE employee_id = $1 AND effective_from = $2', [fy.employee, '2027-01-01']);
    await calcOnly(f, jan);
    const line = (await pool.query('SELECT periodic_taxable::float8 AS p, annual_taxable::float8 AS a FROM payroll_run_lines WHERE run_id = $1 AND employee_id = $2', [jan, y])).rows[0];
    expect(line).toEqual({ p: 0, a: 0 });
    const r = await approveRun(f, jan);
    expect(r.statusCode, JSON.stringify(r.body).slice(0, 300)).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(REMEDY);
    const { stale, current } = await remedy(f, jan, feb, y);
    expect(stale, `Feb PAYE for Y: ${stale} as approved, ${current} on January as it stands`).not.toBe(current);
  });
});
