/**
 * Wave 6 FQd, review #1622 (coordinator ruling): the SDL month-to-date catch-up when a week tips an exempt month.
 *  - Two weekly employees at R5 000 each (R10 000 a week) on eleven months of R40 000 (R440 000 a year): weeks 1-2 read
 *    exempt (R0). Week 3 both earn R10 000 (R20 000): x 52 / 12 tips the month (R526 667, liable). Week 3 carries its own
 *    1% (R200) plus weeks 1-2's (R200), split by leviable share (R200 each line). Week 4 stays liable. The month's EMP201
 *    SDL is 1% of its leviable pay (R600 on R60 000).
 *  - A month that stays exempt: R0 on every run and on the EMP201.
 *  - Runs not yet final never keep each other liable (review M-A); the month's SDL is computed at month level, so a
 *    reopened, re-costed run already caught up owes nothing more and the month stays at exactly 1% (review M-B).
 *  - Approval re-judges THIS run only: a week costed before an earlier week was approved is refused (sdl_recalculate)
 *    until recalculated; a week not yet final never makes another liable (week 2 approves exempt beside a liable,
 *    unapproved week 3); approved weeks are never sent back; the month still ends at 1% of its leviable pay.
 *
 * Disposable DB only (rig -> assertDisposable).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rig, type Route } from './brkr.helpers';
import { cleanup, type R } from './pe-payslip-email.helpers';
import runs from '../../pages/api/payroll/runs';
import payFrequency from '../../pages/api/payroll/employees/[id]/pay-frequency';
import { generateEMP201 } from '@/modules/accounting/services/reports/emp201Service';
import { sdlRecalculateRefusal } from '@/modules/accounting/services/payroll/payrollSdlMonthGate';

let tip: R;
let exempt: R;
let gate: R;
let typo: R;
let mixed: R;
const create = (r: R, start: string) => r.call(runs as Route, 'POST', '/api/payroll/runs', undefined, { body: { frequency: 'weekly', periodStart: start } });
const WEEKS = ['2026-12-28', '2027-01-04', '2027-01-11', '2027-01-18'];

async function history(r: R, monthly: number): Promise<void> {
  for (let m = 2; m <= 12; m += 1) {
    await r.pool.query(
      `INSERT INTO payroll_run_headers (company_id, period_year, period_month, status, total_gross, approved_at, pay_frequency, run_kind)
       VALUES ($1, 2026, $2, 'approved', $3, now(), 'monthly', 'regular')`, [r.company, m, monthly]);
  }
}
/** Two weekly employees at `pay` each, their salary rows. */
async function staff(r: R, pay: number): Promise<string[]> {
  const rows: string[] = [];
  for (let i = 0; i < 2; i += 1) {
    const { employee, salaryRow } = await r.employee(pay);
    const put = await r.call(payFrequency as Route, 'PUT', `/api/payroll/employees/${employee}/pay-frequency`, employee, { body: { payFrequency: 'weekly' } });
    expect(put.statusCode).toBe(200);
    rows.push(salaryRow);
  }
  return rows;
}
const lines = async (r: R, run: string) => (await r.pool.query(
  'SELECT sdl::float8 AS sdl, sdl_exempt FROM payroll_run_lines WHERE run_id = $1 ORDER BY sdl', [run])).rows.map((l) => [Number(l.sdl), l.sdl_exempt]);
async function paid(r: R, run: string): Promise<void> {
  expect((await r.api.calculate(run)).statusCode).toBe(200);
  const ap = await r.api.approve(run);
  expect(ap.statusCode, r.msg(ap)).toBe(200);
}
const emp201Sdl = async (r: R) => (await generateEMP201(r.company, '2027-01-01', '2027-01-31')).totalSDL;

beforeAll(async () => {
  tip = await rig('fqd-sdl-tip');
  exempt = await rig('fqd-sdl-exempt');
  gate = await rig('fqd-sdl-gate');
  typo = await rig('fqd-sdl-typo');
  mixed = await rig('fqd-sdl-mixed');
  for (const r of [tip, exempt, gate, typo, mixed]) await r.setup();
}, 240_000);
afterAll(async () => { for (const r of [tip, exempt, gate, typo, mixed]) await cleanup(r); });

describe('the SDL month-to-date catch-up', () => {
  it('a week that tips an exempt month carries the earlier weeks\' 1%, shared by leviable pay; the EMP201 is 1% of the month', async () => {
    const rows = await staff(tip, 5000);
    await history(tip, 40000);
    const ids: string[] = [];
    for (const w of WEEKS) ids.push(String((await create(tip, w)).body.data!.id));
    await paid(tip, ids[0]!);
    await paid(tip, ids[1]!);
    for (const row of rows) await tip.setSalary(row, 10000);
    await paid(tip, ids[2]!);
    await paid(tip, ids[3]!);
    expect(await Promise.all(ids.map((id) => lines(tip, id)))).toEqual([
      [[0, true], [0, true]],
      [[0, true], [0, true]],
      [[200, false], [200, false]],
      [[100, false], [100, false]],
    ]);
    expect(await emp201Sdl(tip)).toBe(600);
  }, 240_000);

  it('a month that stays exempt carries no SDL on any run or on the EMP201', async () => {
    await staff(exempt, 2500);
    await history(exempt, 30000);
    for (const w of WEEKS) {
      const id = String((await create(exempt, w)).body.data!.id);
      await paid(exempt, id);
      expect(await lines(exempt, id)).toEqual([[0, true], [0, true]]);
    }
    expect(await emp201Sdl(exempt)).toBe(0);
  }, 240_000);

  it('approval re-judges only this run: a run costed before the month moved is refused (recalculate), never reopened', async () => {
    const rows = await staff(gate, 5000);
    await history(gate, 40000);
    const ids: string[] = [];
    for (const w of WEEKS.slice(0, 3)) ids.push(String((await create(gate, w)).body.data!.id));
    await paid(gate, ids[0]!);
    expect((await gate.api.calculate(ids[1]!)).statusCode).toBe(200); // week 2 costed exempt...
    for (const row of rows) await gate.setSalary(row, 10000);
    expect((await gate.api.calculate(ids[2]!)).statusCode).toBe(200); // ...then week 3 tips the month (liable).
    // Week 2 judges itself: week 3 is not final, so it never makes week 2 liable (review M-A). Week 2 approves exempt.
    const week2 = await gate.api.approve(ids[1]!);
    expect(week2.statusCode, gate.msg(week2)).toBe(200);
    // Week 3 was costed before week 2 was final: its catch-up moved, so it too is recalculated, then approved.
    // (The PAYE year-to-date gate also asks for it, as week 2 is final now; the SDL gate's own verdict, read directly:)
    expect((await sdlRecalculateRefusal(gate.company, ids[2]!))?.code).toBe('sdl_recalculate');
    expect((await gate.api.approve(ids[2]!)).statusCode).not.toBe(200);
    await paid(gate, ids[2]!);
    expect(await lines(gate, ids[0]!)).toEqual([[0, true], [0, true]]);
    expect(await lines(gate, ids[1]!)).toEqual([[0, true], [0, true]]);
    // The month's SDL is 1% of its leviable pay, whatever the order runs were costed in.
    const month = (await gate.pool.query(
      `SELECT SUM(l.sdl)::float8 AS sdl, round(SUM(l.sdl_leviable) * 0.01, 2)::float8 AS owed FROM payroll_run_lines l
        WHERE l.run_id = ANY($1)`, [ids])).rows[0]!;
    expect(month.sdl).toBe(month.owed);
    expect(await emp201Sdl(gate)).toBe(month.owed);
  }, 240_000);

  // Review M-A: two runs not yet final never keep each other liable. A typo (R100 000 a week) costs both liable; corrected
  // (R1 000 a week, R52 000 a year) and recalculated, both are exempt, and so is the month.
  it('runs not yet final judge themselves: a corrected typo leaves the month exempt', async () => {
    const { employee, salaryRow } = await typo.employee(100000);
    expect((await typo.call(payFrequency as Route, 'PUT', `/api/payroll/employees/${employee}/pay-frequency`, employee,
      { body: { payFrequency: 'weekly' } })).statusCode).toBe(200);
    const w1 = String((await create(typo, '2027-01-04')).body.data!.id);
    const w2 = String((await create(typo, '2027-01-11')).body.data!.id);
    for (const id of [w1, w2]) expect((await typo.api.calculate(id)).statusCode).toBe(200);
    expect([await lines(typo, w1), await lines(typo, w2)]).toEqual([[[1000, false]], [[1000, false]]]);
    await typo.setSalary(salaryRow, 1000);
    for (const id of [w1, w2]) expect((await typo.api.calculate(id)).statusCode).toBe(200);
    expect([await lines(typo, w1), await lines(typo, w2)]).toEqual([[[0, true]], [[0, true]]]);
    await paid(typo, w1);
    await paid(typo, w2);
    expect(await emp201Sdl(typo)).toBe(0);
  }, 240_000);

  // Review M-B: the month's SDL is computed at month level. A weekly run caught up by the monthly run, then reopened and
  // re-costed, owes nothing more (its explanation says the month is already covered): the month stays at exactly 1%.
  it('across a reopen and re-approval with mixed frequencies, the month is exactly 1% of its leviable pay', async () => {
    await mixed.employee(50000);
    const { employee: wk } = await mixed.employee(1000);
    expect((await mixed.call(payFrequency as Route, 'PUT', `/api/payroll/employees/${wk}/pay-frequency`, wk,
      { body: { payFrequency: 'weekly' } })).statusCode).toBe(200);
    const w1 = String((await create(mixed, '2027-01-04')).body.data!.id);
    await paid(mixed, w1);
    expect(await lines(mixed, w1)).toEqual([[0, true]]);
    const month = String((await mixed.call(runs as Route, 'POST', '/api/payroll/runs', undefined, { body: { month: 1, year: 2027 } })).body.data!.id);
    await paid(mixed, month);
    expect(await lines(mixed, month)).toEqual([[510, false]]); // 1% of R50 000 + the week's R1 000 caught up
    expect((await mixed.api.reopen(w1)).statusCode).toBe(200);
    const je = (await mixed.pool.query('SELECT journal_entry_id FROM payroll_run_headers WHERE id = $1', [w1])).rows[0]!.journal_entry_id;
    if (je) expect((await mixed.api.reverse(String(je))).statusCode).toBe(200);
    await paid(mixed, w1);
    expect(await lines(mixed, w1)).toEqual([[0, false]]);
    const steps = (await mixed.pool.query("SELECT explanation->'sdl'->'steps' AS s FROM payroll_run_lines WHERE run_id = $1", [w1])).rows[0]!.s as Array<{ key: string; label: string }>;
    expect(steps.find((x) => x.key === 'sdl.month')?.label).toContain("The month's SDL is already covered by earlier approved runs");
    expect(await emp201Sdl(mixed)).toBe(510);
  }, 240_000);
});
