/**
 * Wave 6 FQd, review #1622 M1 (breaker repro zz-rev1622-sdl-split): SDL leviability (SDLA s4(b), R500 000) is decided
 * ONCE for a weekly or fortnightly month, on its first run annualised by its own periods a year (52, 26), and the
 * month's later runs inherit it. A steady employer at R520 000 a year (eleven earlier months of R43 333.33) is liable
 * in every week of January 2027: each run carries 1% SDL and approves in order, with no sdl_month_split refusal.
 * Before: weeks 1-2 were judged on the month so far (exempt, SDL R0) and week 3 flipped the month. A later week whose
 * own pay would annualise below the threshold inherits the first week's decision.
 *
 * Disposable DB only (rig -> assertDisposable).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rig, type Route } from './brkr.helpers';
import { cleanup, type R } from './pe-payslip-email.helpers';
import runs from '../../pages/api/payroll/runs';
import payWeek from '../../pages/api/payroll/settings/pay-week';
import payFrequency from '../../pages/api/payroll/employees/[id]/pay-frequency';

let weekly: R;
let fortnightly: R;
let inherit: R;
const create = (r: R, body: unknown) => r.call(runs as Route, 'POST', '/api/payroll/runs', undefined, { body });
const putFreq = (r: R, id: string, f: string) =>
  r.call(payFrequency as Route, 'PUT', `/api/payroll/employees/${id}/pay-frequency`, id, { body: { payFrequency: f } });

/** Feb-Dec 2026: one approved run a month of R43 333.33 (R520 000 a year): the trailing history. */
async function history(r: R): Promise<void> {
  for (let m = 2; m <= 12; m += 1) {
    await r.pool.query(
      `INSERT INTO payroll_run_headers (company_id, period_year, period_month, status, total_gross, approved_at, pay_frequency, run_kind)
       VALUES ($1, 2026, $2, 'approved', 43333.33, now(), 'monthly', 'regular')`, [r.company, m]);
  }
}

/** Calculate then approve each run in order; what each line carried and what approval said. */
async function payInOrder(r: R, ids: string[]) {
  const out: Array<{ calc: number; sdl: number; exempt: boolean; approve: number; why: string | null }> = [];
  for (const id of ids) {
    const c = await r.api.calculate(id);
    const line = (await r.pool.query('SELECT sdl::float8 AS sdl, sdl_exempt FROM payroll_run_lines WHERE run_id = $1', [id])).rows[0];
    const ap = await r.api.approve(id);
    out.push({ calc: c.statusCode, sdl: Number(line?.sdl), exempt: line?.sdl_exempt === true, approve: ap.statusCode, why: ap.statusCode === 200 ? null : r.msg(ap) });
  }
  return out;
}

beforeAll(async () => {
  weekly = await rig('fqd-sdl-weekly');
  fortnightly = await rig('fqd-sdl-fortnightly');
  inherit = await rig('fqd-sdl-inherit');
  await weekly.setup();
  await fortnightly.setup();
  await inherit.setup();
}, 120_000);
afterAll(async () => {
  await cleanup(weekly);
  await cleanup(fortnightly);
  await cleanup(inherit);
});

describe('SDL on a steady payroll at R520 000 a year, decided once for the month', () => {
  it('weekly: all five January weeks carry R100 SDL and approve in order', async () => {
    const { employee } = await weekly.employee(10000);
    expect((await putFreq(weekly, employee, 'weekly')).statusCode).toBe(200);
    await history(weekly);
    const ids: string[] = [];
    for (const s of ['2026-12-28', '2027-01-04', '2027-01-11', '2027-01-18', '2027-01-25']) {
      const made = await create(weekly, { frequency: 'weekly', periodStart: s });
      expect(made.statusCode, s).toBe(201);
      ids.push(String(made.body.data!.id));
    }
    const out = await payInOrder(weekly, ids);
    expect(out).toEqual(ids.map(() => ({ calc: 200, sdl: 100, exempt: false, approve: 200, why: null })));
  }, 240_000);

  it('fortnightly: both January fortnights carry R200 SDL and approve in order', async () => {
    const { employee } = await fortnightly.employee(20000);
    expect((await putFreq(fortnightly, employee, 'fortnightly')).statusCode).toBe(200);
    await history(fortnightly);
    const anchor = await fortnightly.call(payWeek as Route, 'PUT', '/api/payroll/settings/pay-week', undefined,
      { body: { payWeekStartDow: 1, payWeekday: 5, fortnightAnchor: '2026-12-28' } });
    expect(anchor.statusCode).toBe(200);
    const ids: string[] = [];
    for (const s of ['2026-12-28', '2027-01-11']) {
      const made = await create(fortnightly, { frequency: 'fortnightly', periodStart: s });
      expect([made.statusCode, made.body.data?.periodMonth], s).toEqual([201, 1]);
      ids.push(String(made.body.data!.id));
    }
    const out = await payInOrder(fortnightly, ids);
    expect(out).toEqual(ids.map(() => ({ calc: 200, sdl: 200, exempt: false, approve: 200, why: null })));
  }, 240_000);

  it('a later week inherits the first week\'s decision, even when its own pay would annualise below the threshold', async () => {
    // Week 1 at R10 000 annualises to R520 000 (liable). Week 2 at R5 000 alone would read
    // (R476 666.63 + R5 000 x 52 / 12) = R498 333 (exempt); it inherits liable and carries R50.
    const { employee, salaryRow } = await inherit.employee(10000);
    expect((await putFreq(inherit, employee, 'weekly')).statusCode).toBe(200);
    await history(inherit);
    const ids: string[] = [];
    for (const s of ['2026-12-28', '2027-01-04']) ids.push(String((await create(inherit, { frequency: 'weekly', periodStart: s })).body.data!.id));
    const first = await payInOrder(inherit, [ids[0]!]);
    await inherit.setSalary(salaryRow, 5000);
    const second = await payInOrder(inherit, [ids[1]!]);
    expect([...first, ...second]).toEqual([
      { calc: 200, sdl: 100, exempt: false, approve: 200, why: null },
      { calc: 200, sdl: 50, exempt: false, approve: 200, why: null },
    ]);
  }, 240_000);
});
