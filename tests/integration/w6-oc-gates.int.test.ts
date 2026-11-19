/**
 * Wave 6 OC, review #1620: the off-cycle run's gates through the real routes (withAuth, app_user, RLS), two tenants.
 *  - M1: an off-cycle run is approved only on the month's runs as they stand. A regular run reopened, recalculated and
 *    approved again after the bonus was calculated refuses the bonus's approval until it is recalculated. An earlier
 *    off-cycle run is not reopened while a later one costed on it is final (tenant B). FQc's in-month gate stays silent
 *    on a monthly regular run recalculated beside its off-cycle run (moved here from w6-fqc-rev1575 G5).
 *  - M2: each create refusal changes no row; the payroll_off_cycle_employees_guard trigger refuses forged rows;
 *    concurrent creates for one employee serialise (one run, one 409).
 * The clock is SAST 2026-11-17 (Date only, advancing), so the pay-date rules hold whatever day the suite runs.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { rig, type Route } from './brkr.helpers';
import { refusedApproval } from './w6-oc.helpers';
import offCycle from '../../pages/api/payroll/runs/off-cycle';
import { laterOffCycleRefusal } from '@/modules/accounting/services/payroll/payrollOffCycleGates';
import { monthOrderRefusal } from '@/modules/accounting/services/payroll/payrollMonthOrderGate';
import { judgeYearToDate } from '@/modules/accounting/services/payroll/payrollYearToDateGate';

vi.useFakeTimers({ now: new Date('2026-11-17T08:00:00Z'), shouldAdvanceTime: true, toFake: ['Date'] });

type Rig = Awaited<ReturnType<typeof rig>>;
let a: Rig;
let b: Rig;
const bonusOf: Record<string, string> = {};
const basicOf: Record<string, string> = {};
const p: Record<string, string> = {};
const regular: Record<string, string> = {};

const create = (r: Rig, body: Record<string, unknown>) =>
  r.call(offCycle as Route, 'POST', '/api/payroll/runs/off-cycle', undefined, { body: { month: 11, year: 2026, runDate: '2026-11-20', ...body } });
const bonus = (r: Rig, who: string, runDate: string, amount = 1_000) =>
  create(r, { reason: 'bonus', runDate, employees: [{ employeeId: who, componentId: bonusOf[r.company], amount }] });
const n = async (r: Rig, q: string, params: unknown[]) => Number((await r.pool.query(q, params)).rows[0].n);
const runs = (r: Rig) => n(r, 'SELECT count(*) AS n FROM payroll_run_headers WHERE company_id = $1', [r.company]);
/** A created, calculated and approved off-cycle run. */
async function approvedBonus(r: Rig, who: string, runDate: string): Promise<string> {
  const made = await bonus(r, who, runDate);
  expect(made.statusCode, JSON.stringify(made.body)).toBe(201);
  const id = String(made.body.data!.id);
  expect((await r.api.calculate(id)).statusCode).toBe(200);
  const ok = await r.api.approve(id);
  expect(ok.statusCode, JSON.stringify(ok.body)).toBe(200);
  return id;
}
/** The SQLSTATE of a direct INSERT into payroll_off_cycle_employees (null: it was accepted). */
async function forged(r: Rig, row: { company: string; run: string; employee: string; component: string | null; amount: number | null }) {
  return r.pool.query(`INSERT INTO payroll_off_cycle_employees (company_id, run_id, employee_id, component_id, amount)
    VALUES ($1, $2, $3, $4, $5)`, [row.company, row.run, row.employee, row.component, row.amount]).then(() => null, (e: { code?: string }) => e.code ?? 'error');
}

beforeAll(async () => {
  a = await rig('w6-oc-g-a');
  b = await rig('w6-oc-g-b');
  for (const r of [a, b]) {
    await r.setup();
    bonusOf[r.company] = (await r.pool.query(`INSERT INTO payroll_components (company_id, name, sars_source_code, component_type)
      VALUES ($1, 'Annual bonus', '3605', 'earning') RETURNING id`, [r.company])).rows[0].id;
  }
  for (const k of ['x', 'open', 'race', 'race2', 'stayer', 'paidLeaver', 'leaver']) p[k] = (await a.employee(12_000)).employee;
  for (const k of ['early', 'late']) p[k] = (await b.employee(12_000)).employee;
  // Left in November before the regular run: that run pays the notice pay (findPaidTerminationRun).
  await a.pool.query(`UPDATE payroll_employees SET end_date = '2026-11-10', termination_reason = 'resignation',
    termination_notice_period_days = 30, termination_served_notice_days = 0, termination_include_leave_payout = false WHERE id = $1`, [p.paidLeaver]);
  for (const r of [a, b]) {
    basicOf[r.company] = (await r.pool.query(`SELECT id FROM payroll_components WHERE company_id = $1 AND name = 'Basic Salary'`, [r.company])).rows[0].id;
    regular[r.company] = await r.calculatedRun(11);
    const ok = await r.api.approve(regular[r.company]!);
    expect(ok.statusCode, JSON.stringify(ok.body)).toBe(200);
  }
}, 180_000);

afterAll(async () => {
  for (const r of [a, b]) {
    await r.pool.query('DELETE FROM payroll_off_cycle_employees WHERE company_id = $1', [r.company]).catch(() => undefined);
    await r.pool.query('DELETE FROM audit_log WHERE company_id = $1', [r.company]).catch(() => undefined);
    await r.teardown();
  }
  vi.useRealTimers();
}, 120_000);

describe('M1: an off-cycle run is approved only on the month\'s runs as they stand', () => {
  it('the regular run reopened and approved again after the bonus was calculated: the bonus is refused until recalculated', async () => {
    const made = await bonus(a, p.x!, '2026-11-18');
    expect(made.statusCode, JSON.stringify(made.body)).toBe(201);
    const x = String(made.body.data!.id);
    expect((await a.api.calculate(x)).statusCode).toBe(200);
    // The bonus is not final, so the regular run may be reopened (nothing final rests on it).
    const reg = regular[a.company]!;
    expect((await a.api.reopen(reg)).statusCode).toBe(200);
    expect(await refusedApproval(a, x)).toMatch(/regular run is not approved, and this run is costed on it/);
    expect((await a.api.calculate(reg)).statusCode).toBe(200);
    // FQc's in-month gate stays silent on a monthly regular run beside its off-cycle run (was w6-fqc-rev1575 G5).
    expect((await monthOrderRefusal(a.company, reg))?.code ?? null).toBeNull();
    expect((await judgeYearToDate(a.company, reg)).blocker?.code ?? null).toBeNull();
    expect((await a.api.approve(reg)).statusCode).toBe(200);
    expect(await refusedApproval(a, x)).toMatch(/approved again after this run was calculated: recalculate this run/);
    expect((await a.header(x)).status).toBe('calculated');
    expect((await a.api.calculate(x)).statusCode).toBe(200);
    expect((await a.api.approve(x)).statusCode).toBe(200);
  });

  it('tenant B: an earlier off-cycle run is not reopened while a later one costed on it is final', async () => {
    const early = await approvedBonus(b, p.early!, '2026-11-20');
    const late = await approvedBonus(b, p.late!, '2026-11-25');
    const refused = await b.api.reopen(early);
    expect(refused.statusCode).toBe(400);
    expect(await laterOffCycleRefusal(b.company, early)).toContain(`the bonus run ${late}`);
    expect((await b.header(early)).status).toBe('approved');
    expect((await b.api.reopen(late)).statusCode).toBe(200);
    expect((await b.api.reopen(early)).statusCode).toBe(200);
    // Tenant A's runs are never B's dependants.
    expect(await laterOffCycleRefusal(b.company, regular[a.company]!)).toBeNull();
  });
});

describe('M2: every create refusal writes nothing', () => {
  it('an employee already on an open off-cycle run of the month: 409', async () => {
    expect((await bonus(a, p.open!, '2026-11-19')).statusCode).toBe(201);
    const before = await runs(a);
    const again = await bonus(a, p.open!, '2026-11-20');
    expect(again.statusCode).toBe(409);
    expect(a.msg(again)).toMatch(/^Brk BRK-\d+ \(BRK-\d+\) is already on the bonus run paid 19 Nov 2026, which is not approved\. Approve that run, or cancel it/);
    expect(await runs(a)).toBe(before);
  });

  it('a bonus for an employee with no line on the regular run: 409', async () => {
    const newcomer = (await a.employee(9_000)).employee;
    const before = await runs(a);
    const made = await bonus(a, newcomer, '2026-11-20');
    expect(made.statusCode).toBe(409);
    expect(a.msg(made)).toMatch(/is not on the November 2026 regular run/);
    expect(await runs(a)).toBe(before);
  });

  it('a bonus on an earning that is not an annual payment (3601): 400', async () => {
    const before = await runs(a);
    const made = await create(a, { reason: 'bonus', employees: [{ employeeId: p.stayer, componentId: basicOf[a.company], amount: 100 }] });
    expect(made.statusCode).toBe(400);
    expect(a.msg(made)).toMatch(/annual-payment earnings \(SARS code 3605\)/);
    expect(await runs(a)).toBe(before);
  });

  it('a termination run for an employee with no end date in the month: 409', async () => {
    const before = await runs(a);
    const made = await create(a, { reason: 'termination', employees: [{ employeeId: p.stayer }] });
    expect(made.statusCode).toBe(409);
    expect(a.msg(made)).toMatch(/is not leaving in November 2026/);
    expect(await runs(a)).toBe(before);
  });

  it('a termination run for a leaver the regular run already paid out: 409', async () => {
    const before = await runs(a);
    const made = await create(a, { reason: 'termination', employees: [{ employeeId: p.paidLeaver }] });
    expect(made.statusCode).toBe(409);
    expect(a.msg(made)).toMatch(/termination pay-outs were already paid in the November 2026 run/);
    expect(await runs(a)).toBe(before);
  });

  it('two creates for one employee at once: one run, one 409 (the regular run\'s row lock serialises them)', async () => {
    const before = await runs(a);
    const got = await Promise.all([bonus(a, p.race!, '2026-11-21', 10), bonus(a, p.race!, '2026-11-21', 20)]);
    expect(got.map((g) => g.statusCode).sort()).toEqual([201, 409]);
    expect(await runs(a)).toBe(before + 1);
    expect(await n(a, 'SELECT count(*) AS n FROM payroll_off_cycle_employees WHERE employee_id = $1', [p.race])).toBe(1);
  });

  it('a create waits for the month\'s regular run row: a peer holding it (FOR SHARE) holds the create until it lets go', async () => {
    const holder = await a.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM payroll_run_headers WHERE id = $1 FOR SHARE', [regular[a.company]]);
      let settled = false;
      const pending = bonus(a, p.race2!, '2026-11-22').then((r) => { settled = true; return r; });
      await new Promise((r) => setTimeout(r, 1_000));
      expect(settled, 'the create must wait on the regular run\'s row lock').toBe(false);
      await holder.query('COMMIT');
      expect((await pending).statusCode).toBe(201);
    } finally {
      holder.release();
    }
  });
});

describe('M2: the payroll_off_cycle_employees_guard trigger refuses forged rows', () => {
  it('another company\'s run, another company\'s employee, a non-3605 bonus, a component on a termination row, a run past draft', async () => {
    const draftBonus = String((await a.pool.query(`SELECT x.run_id FROM payroll_off_cycle_employees x JOIN payroll_run_headers h ON h.id = x.run_id
      WHERE x.employee_id = $1 AND h.status = 'draft'`, [p.open])).rows[0].run_id);
    // Resigned after the regular run's last calculation: their pay-outs are the termination run's.
    await a.pool.query(`UPDATE payroll_employees SET end_date = '2026-11-20', termination_reason = 'resignation',
      termination_notice_period_days = 30, termination_served_notice_days = 0, termination_include_leave_payout = false WHERE id = $1`, [p.leaver]);
    const term = await create(a, { reason: 'termination', runDate: '2026-11-23', employees: [{ employeeId: p.leaver }] });
    expect(term.statusCode, JSON.stringify(term.body)).toBe(201);
    const draftTermination = String(term.body.data!.id);
    const approved = String((await a.pool.query(`SELECT id FROM payroll_run_headers WHERE company_id = $1 AND run_kind = 'off_cycle'
      AND status = 'approved' LIMIT 1`, [a.company])).rows[0].id);
    const before = await n(a, 'SELECT count(*) AS n FROM payroll_off_cycle_employees', []);
    const bonusA = bonusOf[a.company]!;
    expect(await forged(a, { company: b.company, run: draftBonus, employee: p.late!, component: bonusOf[b.company]!, amount: 5 })).toBe('23514');
    expect(await forged(a, { company: a.company, run: draftBonus, employee: p.late!, component: bonusA, amount: 5 })).toBe('23503');
    expect(await forged(a, { company: a.company, run: draftBonus, employee: p.stayer!, component: basicOf[a.company]!, amount: 5 })).toBe('23514');
    expect(await forged(a, { company: a.company, run: draftTermination, employee: p.stayer!, component: bonusA, amount: 5 })).toBe('23514');
    expect(await forged(a, { company: a.company, run: approved, employee: p.stayer!, component: bonusA, amount: 5 })).toBe('23514');
    expect(await n(a, 'SELECT count(*) AS n FROM payroll_off_cycle_employees', [])).toBe(before);
    // The same row on this company's own draft bonus run is accepted: the refusals above are the guard's, not the shape's.
    expect(await forged(a, { company: a.company, run: draftBonus, employee: p.stayer!, component: bonusA, amount: 5 })).toBeNull();
  });
});
