/**
 * Wave 6 OC, review #1620 breaker delta H (rev1620-brk-sdl-deadlock), through the real routes:
 *  - the month's SDL decision is binding once a run of it is final: a later off-cycle run (here a termination run whose
 *    pay-outs would push the month's estimate over the threshold) takes that decision, so the SDL month gate never sends
 *    anyone back to a final run, and every November run ends final with the EMP201 declaring them all;
 *  - an off-cycle run whose pay date has passed is not reopened (409): a paid run is corrected by a later run.
 * The clock is SAST (Date only, advancing): the bonus is paid on 17 November, the termination run made on the 18th.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { rig, type Route } from './brkr.helpers';
import offCycle from '../../pages/api/payroll/runs/off-cycle';
import { generateEMP201 } from '@/modules/accounting/services/reports/emp201Service';

// 23:15 SAST on 17 November: the minted sessions stay valid across the move to the 18th below.
vi.useFakeTimers({ now: new Date('2026-11-17T21:15:00Z'), shouldAdvanceTime: true, toFake: ['Date'] });

let a: Awaited<ReturnType<typeof rig>>;
let bonusComponent = '';
const p: Record<string, string> = {};
let regular = '';

const create = (body: Record<string, unknown>) =>
  a.call(offCycle as Route, 'POST', '/api/payroll/runs/off-cycle', undefined, { body: { month: 11, year: 2026, ...body } });
const exemptOf = async (runId: string) => (await a.pool.query('SELECT bool_or(sdl_exempt) AS e FROM payroll_run_lines WHERE run_id = $1', [runId])).rows[0].e;

beforeAll(async () => {
  a = await rig('w6-oc-sdl');
  await a.setup();
  // Under the R500 000 threshold on the regular run alone; a large termination pay-out would carry the month over.
  p.mid = (await a.employee(15_000)).employee;
  p.young = (await a.employee(5_300)).employee;
  bonusComponent = (await a.pool.query(`INSERT INTO payroll_components (company_id, name, sars_source_code, component_type)
    VALUES ($1, 'Annual bonus', '3605', 'earning') RETURNING id`, [a.company])).rows[0].id;
  regular = await a.calculatedRun(11);
  expect((await a.api.approve(regular)).statusCode).toBe(200);
}, 120_000);

afterAll(async () => {
  await a.pool.query('DELETE FROM payroll_off_cycle_employees WHERE company_id = $1', [a.company]).catch(() => undefined);
  await a.pool.query('DELETE FROM audit_log WHERE company_id = $1', [a.company]).catch(() => undefined);
  await a.teardown();
  vi.useRealTimers();
}, 120_000);

describe('one SDL decision per month, binding once a run of it is final', () => {
  let bonus = '';
  it('a termination run that would move the month\'s estimate takes the final runs\' decision; every run ends final', async () => {
    const b = await create({ reason: 'bonus', runDate: '2026-11-17', employees: [{ employeeId: p.mid, componentId: bonusComponent, amount: 5_000 }] });
    expect(b.statusCode, JSON.stringify(b.body)).toBe(201);
    bonus = String(b.body.data!.id);
    expect((await a.api.calculate(bonus)).statusCode).toBe(200);
    expect((await a.api.approve(bonus)).statusCode).toBe(200);
    vi.setSystemTime(new Date('2026-11-17T22:05:00Z')); // 00:05 SAST on the 18th: the bonus's pay date has passed
    await a.pool.query(`UPDATE payroll_employees SET end_date = '2026-11-25', termination_reason = 'resignation',
      termination_notice_period_days = 30, termination_served_notice_days = 0, termination_include_leave_payout = false WHERE id = $1`, [p.mid]);
    const t = await create({ reason: 'termination', runDate: '2026-11-26', employees: [{ employeeId: p.mid }] });
    expect(t.statusCode, JSON.stringify(t.body)).toBe(201);
    const term = String(t.body.data!.id);
    expect((await a.api.calculate(term)).statusCode).toBe(200);
    expect(await exemptOf(term)).toBe(await exemptOf(regular));
    expect(await exemptOf(bonus)).toBe(await exemptOf(regular));
    expect((await a.api.approve(term)).statusCode).toBe(200);
    for (const id of [regular, bonus, term]) expect((await a.header(id)).status).toBe('approved');
    const lines = (await a.pool.query(`SELECT COALESCE(SUM(l.paye), 0)::float8 AS paye, COALESCE(SUM(l.sdl), 0)::float8 AS sdl
      FROM payroll_run_lines l JOIN payroll_run_headers h ON h.id = l.run_id WHERE h.company_id = $1 AND h.period_month = 11`, [a.company])).rows[0];
    const emp201 = await generateEMP201(a.company, '2026-11-01', '2026-11-30');
    expect(emp201.totalPAYE).toBeCloseTo(lines.paye, 2);
    expect(emp201.totalSDL).toBeCloseTo(lines.sdl, 2);
  });

  it('the bonus, its pay date passed, is not reopened: 409, it stays approved', async () => {
    const refused = await a.api.reopen(bonus);
    expect(refused.statusCode).toBe(409);
    expect(a.msg(refused)).toMatch(/^This off-cycle run was paid on 17 Nov 2026, so it is not reopened: a paid run is corrected by a later run\./);
    expect((await a.header(bonus)).status).toBe('approved');
  });
});
