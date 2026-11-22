/**
 * Review M1 of e9f437f366: an off-cycle run approved before its payday and reopened ON payday (its approval overlaps
 * payday, the SAST day of its pay date) was paid. The next day its correction is approved (200), and while it is
 * reopened the owner cash forecast treats it as disbursed: its net pay is not needed again (review H1/L4 of 61c35e98c5).
 * No real clock (H1): October 2026 throughout. The app's Date is faked; the database stamps approval times from its own
 * clock, so the approval history, approved_at and the frozen payday are written as the trusted fixture role.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { rig, type Route } from './brkr.helpers';
import offCycle from '../../pages/api/payroll/runs/off-cycle';
import { approvalCoveredPaydaySql } from '@/modules/accounting/services/payroll/payrollPaydayCover';
import { getOwnerCashPosition } from '@/modules/bureau/services/ownerCashPositionService';

// 10:00 SAST, 15 Oct 2026: the regular and bonus runs are approved before the bonus's 20 Oct payday.
vi.useFakeTimers({ now: new Date('2026-10-15T08:00:00Z'), shouldAdvanceTime: true, toFake: ['Date'] });

const PAYDAY = '2026-10-20';
const NEXT_DAY = new Date('2026-10-21T08:00:00Z'); // 10:00 SAST on the day after payday
let a: Awaited<ReturnType<typeof rig>>;
let bonusRun = '';

/** The trusted fixture role writes the approval's real-world times: the 999x triggers leave them as written. */
const setHistory = (history: string) => a.pool.query(`UPDATE payroll_run_headers SET approval_history = $2::tstzmultirange,
    off_cycle_payday_at = (run_date + 1)::timestamp AT TIME ZONE 'Africa/Johannesburg' WHERE id = $1`, [bonusRun, history]);
const disbursed = async () => (await a.pool.query(`SELECT ${approvalCoveredPaydaySql('h')} AS d FROM payroll_run_headers h WHERE h.id = $1`, [bonusRun])).rows[0].d;
/** The app's clock moves days: the sessions minted on 15 Oct have expired, so they are minted again at the new time. */
const moveTo = async (at: Date) => {
  vi.setSystemTime(at);
  for (const u of Object.keys(a.tokens)) a.tokens[u] = await a.mint(u);
};
const forecast = async () => (await getOwnerCashPosition(a.company, 10_000_000, NEXT_DAY)).payroll!;

beforeAll(async () => {
  a = await rig('w6-oc-payday-reopen');
  await a.setup();
  const emp = (await a.employee(15_000)).employee;
  const component = (await a.pool.query(`INSERT INTO payroll_components (company_id, name, sars_source_code, component_type)
    VALUES ($1, 'Annual bonus', '3605', 'earning') RETURNING id`, [a.company])).rows[0].id;
  const regular = await a.calculatedRun(10, 2026);
  expect((await a.api.approve(regular)).statusCode).toBe(200);
  const made = await a.call(offCycle as Route, 'POST', '/api/payroll/runs/off-cycle', undefined, {
    body: { month: 10, year: 2026, reason: 'bonus', runDate: PAYDAY, employees: [{ employeeId: emp, componentId: component, amount: 2_000 }] },
  });
  expect(made.statusCode, JSON.stringify(made.body)).toBe(201);
  bonusRun = String(made.body.data!.id);
  expect((await a.api.calculate(bonusRun)).statusCode).toBe(200);
  const ok = await a.api.approve(bonusRun);
  expect(ok.statusCode, JSON.stringify(ok.body)).toBe(200);
  // Approved at 10:00 SAST on 15 Oct (the database stamped its own today).
  await a.pool.query(`UPDATE payroll_run_headers SET approved_at = '2026-10-15 08:00:00+00' WHERE id = $1`, [bonusRun]);
}, 180_000);

afterAll(async () => {
  vi.useRealTimers();
  await a.pool.query('DELETE FROM payroll_off_cycle_employees WHERE company_id = $1', [a.company]).catch(() => undefined);
  await a.pool.query('DELETE FROM audit_log WHERE company_id = $1', [a.company]).catch(() => undefined);
  await a.teardown();
}, 120_000);

describe('reopened on payday, corrected the next day', () => {
  it('the forecast counts the reopened run as disbursed (no net pay), and the re-approval is 200', async () => {
    const journal = String((await a.pool.query('SELECT journal_entry_id FROM payroll_run_headers WHERE id = $1', [bonusRun])).rows[0].journal_entry_id);
    await moveTo(new Date('2026-10-20T12:00:00Z')); // 14:00 SAST on payday
    expect((await a.api.reopen(bonusRun)).statusCode).toBe(200);
    expect((await a.api.reverse(journal)).statusCode).toBe(200);
    const net = Number((await a.pool.query('SELECT total_net::float8 AS n FROM payroll_run_headers WHERE id = $1', [bonusRun])).rows[0].n);
    expect(net).toBeGreaterThan(0);

    // Approved 15 Oct 10:00 SAST, reopened on payday at 14:00 SAST: overlaps payday.
    await setHistory('{["2026-10-15 08:00:00+00","2026-10-20 12:00:00+00")}');
    await moveTo(NEXT_DAY);
    expect(await disbursed()).toBe(true);
    const paidOut = await forecast();
    // The same run reopened on 19 Oct instead: never paid, so its net pay is still needed.
    await setHistory('{["2026-10-15 08:00:00+00","2026-10-19 08:00:00+00")}');
    expect(await disbursed()).toBe(false);
    const notPaid = await forecast();
    expect(notPaid.totalRequired - paidOut.totalRequired).toBeCloseTo(net, 2);

    await setHistory('{["2026-10-15 08:00:00+00","2026-10-20 12:00:00+00")}');
    expect((await a.api.calculate(bonusRun)).statusCode).toBe(200);
    const ok = await a.api.approve(bonusRun);
    expect(ok.statusCode, JSON.stringify(ok.body)).toBe(200);
  });
});
