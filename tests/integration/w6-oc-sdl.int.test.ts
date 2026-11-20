/**
 * Wave 6 OC, review #1620 final breaker H: SDL as a month-to-date catch-up (sdlLeviabilityService.sdlCatchUp, FQd's month-to-date catch-up), through the real
 * routes, three tenants:
 *  - A (rev1620-brk-sdl-lock): an exempt regular month, then a R600 000 bonus: the bonus run is liable and carries the
 *    regular run's 1%, so the month's EMP201 SDL is 1% of all it paid (R6 203);
 *  - B (rev1620-brk-sdl-deadlock): a bonus paid and approved on the 17th, then a termination run that tips the month:
 *    it carries the earlier runs' 1%, nobody is sent back to reopen a final run, every run ends final;
 *  - C: a month that stays exempt levies nothing on any of its runs.
 *  - D: only the month's FINAL earlier runs are caught up (the loader, read directly);
 *  - E (FQd delta 2): a bonus caught up by a later termination run, then corrected down (termination reopened, bonus
 *    reopened, edited, both approved again): the month ends at exactly 1% of its leviable pay.
 * In every case the month's EMP201 SDL equals 1% of the month's leviable lines (each rounded to the cent).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { rig, type Route } from './brkr.helpers';
import offCycle from '../../pages/api/payroll/runs/off-cycle';
import amounts from '../../pages/api/payroll/runs/[id]/off-cycle-amounts';
import { generateEMP201 } from '@/modules/accounting/services/reports/emp201Service';
import { sdlCatchUp } from '@/modules/accounting/services/payroll/sdlLeviabilityService';

// 23:15 SAST on 17 November: the minted sessions stay valid across the move to the 18th below.
vi.useFakeTimers({ now: new Date('2026-11-17T21:15:00Z'), shouldAdvanceTime: true, toFake: ['Date'] });

type Rig = Awaited<ReturnType<typeof rig>>;
const r: Record<'a' | 'b' | 'c' | 'd' | 'e', Rig> = {} as never;
const bonusOf: Record<string, string> = {};
const regular: Record<string, string> = {};
const mid: Record<string, string> = {};

const create = (t: Rig, body: Record<string, unknown>) =>
  t.call(offCycle as Route, 'POST', '/api/payroll/runs/off-cycle', undefined, { body: { month: 11, year: 2026, ...body } });
const bonus = (t: Rig, amount: number, runDate: string) =>
  create(t, { reason: 'bonus', runDate, employees: [{ employeeId: mid[t.company], componentId: bonusOf[t.company], amount }] });
/** Calculated and approved; returns the run id. */
async function final(t: Rig, made: { statusCode: number; body: { data?: { id?: unknown } } }): Promise<string> {
  expect(made.statusCode, JSON.stringify(made.body)).toBe(201);
  const id = String(made.body.data!.id);
  expect((await t.api.calculate(id)).statusCode).toBe(200);
  const ok = await t.api.approve(id);
  expect(ok.statusCode, JSON.stringify(ok.body)).toBe(200);
  return id;
}
/** The month's lines: SDL levied, and 1% of each line's leviable amount rounded to the cent. */
async function month(t: Rig) {
  return (await t.pool.query(`SELECT COALESCE(SUM(l.sdl), 0)::float8 AS levied, COALESCE(SUM(ROUND(l.sdl_leviable * 0.01, 2)), 0)::float8 AS due
    FROM payroll_run_lines l JOIN payroll_run_headers h ON h.id = l.run_id
    WHERE h.company_id = $1 AND h.period_year = 2026 AND h.period_month = 11 AND h.status = 'approved'`, [t.company])).rows[0];
}
const sdlOf = async (t: Rig, id: string) => Number((await t.pool.query('SELECT COALESCE(SUM(sdl), 0)::float8 AS s FROM payroll_run_lines WHERE run_id = $1', [id])).rows[0].s);

beforeAll(async () => {
  for (const k of ['a', 'b', 'c', 'd', 'e'] as const) {
    r[k] = await rig(`w6-oc-sdl-${k}`);
    const t = r[k];
    await t.setup();
    mid[t.company] = (await t.employee(15_000)).employee;
    await t.employee(5_300);
    bonusOf[t.company] = (await t.pool.query(`INSERT INTO payroll_components (company_id, name, sars_source_code, component_type)
      VALUES ($1, 'Annual bonus', '3605', 'earning') RETURNING id`, [t.company])).rows[0].id;
    regular[t.company] = await t.calculatedRun(11);
    if (k !== 'd') expect((await t.api.approve(regular[t.company]!)).statusCode).toBe(200);
  }
}, 180_000);

afterAll(async () => {
  for (const t of Object.values(r)) {
    await t.pool.query('DELETE FROM payroll_off_cycle_employees WHERE company_id = $1', [t.company]).catch(() => undefined);
    await t.pool.query('DELETE FROM audit_log WHERE company_id = $1', [t.company]).catch(() => undefined);
    await t.teardown();
  }
  vi.useRealTimers();
}, 120_000);

describe('SDL settled for the month to date', () => {
  it('A: an exempt regular month, then a R600 000 bonus: the bonus carries 1% of the whole month (R6 203)', async () => {
    const t = r.a;
    expect(await sdlOf(t, regular[t.company]!)).toBe(0);
    const id = await final(t, await bonus(t, 600_000, '2026-11-27'));
    expect(await sdlOf(t, id)).toBe(6_203);
    expect((await t.pool.query('SELECT bool_or(sdl_exempt) AS e FROM payroll_run_lines WHERE run_id = $1', [regular[t.company]])).rows[0].e).toBe(true);
    const m = await month(t);
    expect(m.levied).toBeCloseTo(m.due, 2);
    expect((await generateEMP201(t.company, '2026-11-01', '2026-11-30')).totalSDL).toBeCloseTo(6_203, 2);
    // The line says why (FQd's month step): this run carries the month's SDL, the earlier runs' share included.
    const steps = (await t.pool.query(`SELECT explanation->'sdl'->'steps' AS s FROM payroll_run_lines WHERE run_id = $1`, [id])).rows[0].s as Array<{ key: string; amount: number }>;
    expect(steps.find((s) => s.key === 'sdl.month')?.amount).toBe(6_203);

    // P7 (FQd's breaker case, off-cycle): the bonus, final with its R203 catch-up, is reopened, recalculated and approved
    // again. The month's SDL stays exactly 1% of its leviable pay (R6 203), never 1% plus the catch-up again.
    expect((await t.api.reopen(id)).statusCode).toBe(200);
    const journal = String((await t.pool.query('SELECT journal_entry_id FROM payroll_run_headers WHERE id = $1', [id])).rows[0].journal_entry_id);
    expect((await t.api.reverse(journal)).statusCode).toBe(200);
    expect((await t.api.calculate(id)).statusCode).toBe(200);
    const again = await t.api.approve(id);
    expect(again.statusCode, JSON.stringify(again.body)).toBe(200);
    expect(await sdlOf(t, id)).toBe(6_203);
    const after = await month(t);
    expect(after.levied).toBeCloseTo(6_203, 2);
    expect((await generateEMP201(t.company, '2026-11-01', '2026-11-30')).totalSDL).toBeCloseTo(6_203, 2);
  });

  it('B: a termination run that tips the month carries the earlier runs\' 1%; every run ends final without a reopen', async () => {
    const t = r.b;
    const b = await final(t, await bonus(t, 5_000, '2026-11-17'));
    vi.setSystemTime(new Date('2026-11-17T22:05:00Z')); // 00:05 SAST on the 18th
    await t.pool.query(`UPDATE payroll_employees SET end_date = '2026-11-25', termination_reason = 'resignation',
      termination_notice_period_days = 30, termination_served_notice_days = 0, termination_include_leave_payout = false WHERE id = $1`, [mid[t.company]]);
    const term = await final(t, await create(t, { reason: 'termination', runDate: '2026-11-26', employees: [{ employeeId: mid[t.company] }] }));
    for (const id of [regular[t.company]!, b, term]) expect((await t.header(id)).status).toBe('approved');
    expect(await sdlOf(t, regular[t.company]!)).toBe(0);
    expect(await sdlOf(t, b)).toBe(0);
    const m = await month(t);
    expect(await sdlOf(t, term)).toBeCloseTo(m.due, 2);
    expect((await generateEMP201(t.company, '2026-11-01', '2026-11-30')).totalSDL).toBeCloseTo(m.due, 2);
  });

  it('C: a month that stays exempt levies nothing on any run', async () => {
    const t = r.c;
    const id = await final(t, await bonus(t, 1_000, '2026-11-27'));
    expect(await sdlOf(t, id)).toBe(0);
    expect((await month(t)).levied).toBe(0);
    expect((await generateEMP201(t.company, '2026-11-01', '2026-11-30')).totalSDL).toBe(0);
  });

  it('D: only FINAL earlier runs count toward the catch-up (a calculated run paid earlier in the month carries nothing)', async () => {
    const t = r.d;
    expect((await t.api.approve(regular[t.company]!)).statusCode).toBe(200);
    const made = await bonus(t, 600_000, '2026-11-27');
    expect(made.statusCode, JSON.stringify(made.body)).toBe(201);
    const id = String(made.body.data!.id);
    expect((await t.api.calculate(id)).statusCode).toBe(200);
    expect(await sdlCatchUp(t.company, id, false)).toEqual({ liable: false, earlierLeviable: 20300, earlierSdl: 0 });
    // A run of the month paid earlier (the 20th) but not final (calculated): nothing of it is caught up.
    const seeded = String((await t.pool.query(`INSERT INTO payroll_run_headers (company_id, period_month, period_year, status, run_date,
        run_kind, off_cycle_reason, period_start, period_end, employee_count)
      VALUES ($1, 11, 2026, 'calculated', '2026-11-20', 'off_cycle', 'bonus', '2026-11-01', '2026-11-30', 1) RETURNING id`, [t.company])).rows[0].id);
    try {
      await t.pool.query(`INSERT INTO payroll_run_lines (run_id, employee_id, gross_pay, taxable_income, paye, net_pay, sdl, sdl_leviable, sdl_exempt)
        VALUES ($1, $2, 10000, 10000, 0, 10000, 0, 10000, true)`, [seeded, mid[t.company]]);
      expect(await sdlCatchUp(t.company, id, false)).toEqual({ liable: false, earlierLeviable: 20300, earlierSdl: 0 });
    } finally {
      await t.pool.query('DELETE FROM payroll_run_lines WHERE run_id = $1', [seeded]);
      await t.pool.query('DELETE FROM payroll_run_headers WHERE id = $1', [seeded]);
    }
  });

  it('E: a bonus caught up by a later termination run, corrected down after both were final: the month ends at exactly 1%', async () => {
    const t = r.e;
    const exactly1pct = async () => {
      const m = await month(t);
      const lev = Number((await t.pool.query(`SELECT COALESCE(SUM(l.sdl_leviable), 0)::float8 AS v FROM payroll_run_lines l
        JOIN payroll_run_headers h ON h.id = l.run_id WHERE h.company_id = $1 AND h.period_year = 2026 AND h.period_month = 11
        AND h.status = 'approved'`, [t.company])).rows[0].v);
      expect(m.levied).toBeCloseTo(Math.round(lev) / 100, 2);
      expect((await generateEMP201(t.company, '2026-11-01', '2026-11-30')).totalSDL).toBeCloseTo(Math.round(lev) / 100, 2);
      return m.levied;
    };
    const b = await final(t, await bonus(t, 5_000, '2026-11-18'));
    await t.pool.query(`UPDATE payroll_employees SET end_date = '2026-11-25', termination_reason = 'resignation',
      termination_notice_period_days = 30, termination_served_notice_days = 0, termination_include_leave_payout = false WHERE id = $1`, [mid[t.company]]);
    const term = await final(t, await create(t, { reason: 'termination', runDate: '2026-11-26', employees: [{ employeeId: mid[t.company] }] }));
    const before = await exactly1pct();
    expect(await sdlOf(t, term)).toBeCloseTo(before, 2); // the termination tipped the month and caught it up
    // Correct the bonus down: the later termination first (a run with a later final run is not reopened), then the bonus.
    const journalOf = async (id: string) => String((await t.pool.query('SELECT journal_entry_id FROM payroll_run_headers WHERE id = $1', [id])).rows[0].journal_entry_id);
    for (const id of [term, b]) {
      const reopened = await t.api.reopen(id);
      expect(reopened.statusCode, t.msg(reopened)).toBe(200);
      expect((await t.api.reverse(await journalOf(id))).statusCode).toBe(200);
    }
    const edit = await t.call(amounts as Route, 'PATCH', `/api/payroll/runs/${b}/off-cycle-amounts`, b, { body: { employeeId: mid[t.company], amount: 1_000 } });
    expect(edit.statusCode, t.msg(edit)).toBe(200);
    for (const id of [b, term]) {
      expect((await t.api.calculate(id)).statusCode).toBe(200);
      const ok = await t.api.approve(id);
      expect(ok.statusCode, JSON.stringify(ok.body)).toBe(200);
    }
    const after = await exactly1pct();
    expect(after).toBeLessThan(before);
  });
});
