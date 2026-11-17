/**
 * Wave 6 OC: off-cycle bonus and termination runs, through the real routes (withAuth, app_user, RLS) on the disposable
 * fixture, two tenants. Needs FQx's schema (the per-month unique dropped): a month's regular run and its off-cycle run.
 *
 *  - bonus after the regular run: PAYE as an annual payment on the month's AE (the regular line in the year to date,
 *    spec F2; PAYE-GEN-01-G21 (2027) pp. 32-33), n unchanged; UIF capped across the month's runs (UIC Act s6(2));
 *    ETI recomputed for the month, the bonus line carrying the NEGATIVE difference (ETI Act s7);
 *  - termination after the regular run: the leaver's notice pay (3605) alone;
 *  - approve, journal "Payroll run 2026-11 bonus", R-035 per run; the regular run cannot be reopened under it;
 *  - refusals (no approved regular run, a pay date passed at approval, another company's employee or run) change no row.
 * The clock is SAST 2026-11-17 (Date only, advancing), so the pay-date rules hold whatever day the suite runs.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { rig, type Route } from './brkr.helpers';
import offCycle from '../../pages/api/payroll/runs/off-cycle';

vi.useFakeTimers({ now: new Date('2026-11-17T08:00:00Z'), shouldAdvanceTime: true, toFake: ['Date'] });

let a: Awaited<ReturnType<typeof rig>>;
let b: Awaited<ReturnType<typeof rig>>;
let bonusComponent: string;
const people: Record<'high' | 'young' | 'leaver' | 'spare1' | 'spare2', string> = { high: '', young: '', leaver: '', spare1: '', spare2: '' };
let regular = '';

const create = (r: typeof a, body: Record<string, unknown>) =>
  r.call(offCycle as Route, 'POST', '/api/payroll/runs/off-cycle', undefined, { body: { month: 11, year: 2026, runDate: '2026-11-27', ...body } });
const line = async (runId: string, employee: string) => (await a.pool.query(
  `SELECT paye::float8, uif_employee::float8 AS uif, eti::float8, periodic_taxable::float8 AS periodic, annual_taxable::float8 AS annual,
          gross_pay::float8 AS gross, component_breakdown FROM payroll_run_lines WHERE run_id = $1 AND employee_id = $2`, [runId, employee])).rows[0];
const count = async (sqlText: string, params: unknown[]) => Number((await a.pool.query(sqlText, params)).rows[0].n);

beforeAll(async () => {
  a = await rig('w6-oc-a');
  b = await rig('w6-oc-b');
  await a.setup();
  await b.setup();
  people.high = (await a.employee(40_000)).employee;
  people.young = (await a.employee(5_300)).employee;
  people.leaver = (await a.employee(20_000)).employee;
  people.spare1 = (await a.employee(15_000)).employee;
  people.spare2 = (await a.employee(15_000)).employee;
  // ETI: 22 at month end, an ID shown, 40 hours a week, employed since January 2026 (ETI Act s6).
  await a.pool.query(`UPDATE payroll_employees SET date_of_birth = '2004-06-01', id_number = '0406015009086', hours_per_week = 40,
    start_date = '2026-01-01', medical_aid_main_member = false WHERE id = $1`, [people.young]);
  bonusComponent = (await a.pool.query(`INSERT INTO payroll_components (company_id, name, sars_source_code, component_type)
    VALUES ($1, 'Annual bonus', '3605', 'earning') RETURNING id`, [a.company])).rows[0].id;
  regular = await a.calculatedRun(11);
  const approved = await a.api.approve(regular);
  expect(approved.statusCode, JSON.stringify(approved.body)).toBe(200);
  // Resigned after the regular run was approved: notice not served (30 days of pay), no leave pay-out.
  await a.pool.query(`UPDATE payroll_employees SET end_date = '2026-11-20', termination_reason = 'resignation',
    termination_notice_period_days = 30, termination_served_notice_days = 0, termination_include_leave_payout = false WHERE id = $1`, [people.leaver]);
}, 120_000);

afterAll(async () => {
  for (const r of [a, b]) {
    await r.pool.query('DELETE FROM payroll_off_cycle_employees WHERE company_id = $1', [r.company]).catch(() => undefined);
    await r.pool.query('DELETE FROM audit_log WHERE company_id = $1', [r.company]).catch(() => undefined);
    await r.teardown();
  }
  vi.useRealTimers();
}, 120_000);

describe('OC: a bonus run after the month\'s regular run', () => {
  let bonus = '';
  it('is created for employees on the regular run, and costed on the month', async () => {
    const made = await create(a, { reason: 'bonus', employees: [
      { employeeId: people.high, componentId: bonusComponent, amount: 20_000 },
      { employeeId: people.young, componentId: bonusComponent, amount: 1_000 },
    ] });
    expect(made.statusCode, JSON.stringify(made.body)).toBe(201);
    bonus = String(made.body.data!.id);
    expect(made.body.data).toMatchObject({ runKind: 'off_cycle', offCycleReason: 'bonus', runDate: '2026-11-27', periodMonth: 11 });
    const calc = await a.api.calculate(bonus);
    expect(calc.statusCode, JSON.stringify(calc.body)).toBe(200);

    const reg = await line(regular, people.high);
    const high = await line(bonus, people.high);
    // Only the bonus: no salary, no recurring component.
    expect(high.gross).toBe(20_000);
    expect(high.periodic).toBe(0);
    expect(high.annual).toBe(20_000);
    // UIF: the regular line took the month's cap (R40 000 is above the ceiling), so the bonus takes none (UIC Act s6(2)).
    expect(reg.uif).toBeGreaterThan(0);
    expect(high.uif).toBe(0);
    // PAYE on the month's AE (spec F2): tax(AE + A) - tax(AE) with AE = 40 000 x 12 = 480 000, in the 2027 31% bracket
    // (R383 101 - R530 200): 31% of R20 000. Without the regular line in the year to date, AE would be nil.
    expect(high.paye).toBe(6_200);

    const young = await line(bonus, people.young);
    const youngReg = await line(regular, people.young);
    expect(youngReg.eti).toBe(1_500);
    // The month's R6 300 is in the year-one taper: 1 500 - 0.75 x 800 = 900, so the bonus line reverses R600 (ETI Act s7).
    expect(young.eti).toBe(-600);
    // UIF: R53 + R10 = 1% of the month's R6 300, below the cap.
    expect(young.uif).toBe(10);
  });

  it('a regular month counts one period: the bonus is not a period', async () => {
    const regular2 = await a.pool.query(`SELECT count(*)::int AS n FROM payroll_run_lines l JOIN payroll_run_headers h ON h.id = l.run_id
      WHERE h.company_id = $1 AND l.employee_id = $2 AND l.periodic_taxable > 0`, [a.company, people.high]);
    expect(regular2.rows[0].n).toBe(1);
  });

  it('approves on its own (R-035 per run), posts "Payroll run 2026-11 bonus", and pins the regular run', async () => {
    const approved = await a.api.approve(bonus);
    expect(approved.statusCode, JSON.stringify(approved.body)).toBe(200);
    const journals = await a.journals('11');
    expect(journals.map((j) => j.description)).toEqual(expect.arrayContaining(['Payroll run 2026-11', 'Payroll run 2026-11 bonus']));
    const ref = await a.pool.query(`SELECT document_reference FROM approval_requests WHERE company_id = $1 AND document_id = $2`, [a.company, bonus]);
    expect(ref.rows.map((r) => r.document_reference)).toContain('11/2026 bonus run');
    const reopened = await a.api.reopen(regular);
    expect(reopened.statusCode).toBe(409);
    expect(a.msg(reopened)).toMatch(/off-cycle runs were costed on this run's lines/);
    expect((await a.header(regular)).status).toBe('approved');
  });
});

describe('OC: a termination run after the month\'s regular run', () => {
  it('pays the leaver\'s notice pay alone', async () => {
    const made = await create(a, { reason: 'termination', employees: [{ employeeId: people.leaver }] });
    expect(made.statusCode, JSON.stringify(made.body)).toBe(201);
    const id = String(made.body.data!.id);
    expect((await a.api.calculate(id)).statusCode).toBe(200);
    const l = await line(id, people.leaver);
    const codes = (l.component_breakdown as Array<{ componentId: string; sarsSourceCode: string }>).map((c) => c.componentId);
    expect(codes).toEqual(['synthetic:termination:notice-pay']);
    expect(l.periodic).toBe(0);
    expect(l.gross).toBeGreaterThan(0);
  });
});

describe('OC: refusals change no row', () => {
  it('no approved regular run in the month: 409, no header', async () => {
    const before = await count('SELECT count(*) AS n FROM payroll_run_headers WHERE company_id = $1', [b.company]);
    const emp = (await b.employee(10_000)).employee;
    const made = await create(b, { reason: 'termination', employees: [{ employeeId: emp }] });
    expect(made.statusCode).toBe(409);
    expect(b.msg(made)).toMatch(/no approved regular run/);
    expect(await count('SELECT count(*) AS n FROM payroll_run_headers WHERE company_id = $1', [b.company])).toBe(before);
  });

  it('another company\'s employee: 400, nothing written', async () => {
    const before = await count('SELECT count(*) AS n FROM payroll_run_headers WHERE company_id = $1', [a.company]);
    const made = await create(a, { reason: 'bonus', employees: [{ employeeId: (await b.employee(9_000)).employee, componentId: bonusComponent, amount: 10 }] });
    expect(made.statusCode).toBe(400);
    expect(await count('SELECT count(*) AS n FROM payroll_run_headers WHERE company_id = $1', [a.company])).toBe(before);
  });

  it('company B cannot cost or approve company A\'s off-cycle run', async () => {
    const made = await create(a, { reason: 'bonus', employees: [{ employeeId: people.spare1, componentId: bonusComponent, amount: 50 }] });
    expect(made.statusCode, JSON.stringify(made.body)).toBe(201);
    const id = String(made.body.data!.id);
    expect([404, 400]).toContain((await b.api.calculate(id)).statusCode);
    expect(await count('SELECT count(*) AS n FROM payroll_run_lines WHERE run_id = $1', [id])).toBe(0);
  });

  it('a pay date passed by approval: refused, the run stays calculated (carried item 2, #1549 D1)', async () => {
    const made = await create(a, { reason: 'bonus', employees: [{ employeeId: people.spare2, componentId: bonusComponent, amount: 100 }] });
    const id = String(made.body.data!.id);
    expect((await a.api.calculate(id)).statusCode).toBe(200);
    await a.pool.query(`UPDATE payroll_run_headers SET run_date = '2026-11-16' WHERE id = $1`, [id]);
    const approved = await a.api.approve(id);
    expect(approved.statusCode).not.toBe(200);
    expect(a.msg(approved)).toMatch(/before today/);
    expect((await a.header(id)).status).toBe('calculated');
    expect(await count('SELECT count(*) AS n FROM gl_journal_entries WHERE company_id = $1 AND description = $2', [a.company, 'Payroll run 2026-11 bonus'])).toBe(1);
  });
});
