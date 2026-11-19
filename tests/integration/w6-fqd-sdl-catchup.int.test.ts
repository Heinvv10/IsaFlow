/**
 * Wave 6 FQd, review #1622 (coordinator ruling): the SDL month-to-date catch-up when a week tips an exempt month.
 *  - Two weekly employees at R5 000 each (R10 000 a week) on eleven months of R40 000 (R440 000 a year): weeks 1-2 read
 *    exempt (R0). Week 3 both earn R10 000 (R20 000): x 52 / 12 tips the month (R526 667, liable). Week 3 carries its own
 *    1% (R200) plus weeks 1-2's (R200), split by leviable share (R200 each line). Week 4 stays liable. The month's EMP201
 *    SDL is 1% of its leviable pay (R600 on R60 000).
 *  - A month that stays exempt: R0 on every run and on the EMP201.
 *  - Approval re-judges THIS run only: a week costed exempt before a later week tipped the month, and a week costed
 *    before the week it catches up was final, are each refused (sdl_recalculate) until recalculated; the approved week 1
 *    is never sent back, and the month still ends at 1% of its leviable pay.
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
  for (const r of [tip, exempt, gate]) await r.setup();
}, 180_000);
afterAll(async () => { for (const r of [tip, exempt, gate]) await cleanup(r); });

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
    // Week 2, now in a liable month, is refused at approval until it is recalculated; week 1 (approved) is never touched.
    const week2 = await gate.api.approve(ids[1]!);
    expect([week2.statusCode === 200, gate.msg(week2)]).toEqual([false, expect.stringContaining('Recalculate this run, then approve it.')]);
    await paid(gate, ids[1]!);
    // Week 3 was costed before week 2 was final: its catch-up moved, so it too is recalculated, then approved.
    // (The PAYE year-to-date gate also asks for it, as week 2 is final now; the SDL gate's own verdict, read directly:)
    expect((await sdlRecalculateRefusal(gate.company, ids[2]!))?.code).toBe('sdl_recalculate');
    expect((await gate.api.approve(ids[2]!)).statusCode).not.toBe(200);
    await paid(gate, ids[2]!);
    expect(await lines(gate, ids[0]!)).toEqual([[0, true], [0, true]]);
    // The month's SDL is 1% of its leviable pay, whatever the order runs were costed in.
    const month = (await gate.pool.query(
      `SELECT SUM(l.sdl)::float8 AS sdl, SUM(round(l.sdl_leviable * 0.01, 2))::float8 AS owed FROM payroll_run_lines l
        WHERE l.run_id = ANY($1)`, [ids])).rows[0]!;
    expect(month.sdl).toBe(month.owed);
    expect(await emp201Sdl(gate)).toBe(month.owed);
  }, 240_000);
});
