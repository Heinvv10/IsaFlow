/**
 * Review M1 of e9f437f366: an off-cycle run approved before its payday and reopened ON payday (its approval overlaps
 * payday) was paid. Its correction is approved the next day (200), and the cash forecast treats it as disbursed
 * (approvalCoveredPaydaySql). Real clocks throughout: the run is paid today; "the next day" is reached by moving its pay
 * date, its frozen payday and its approval history back one day together, as the trusted fixture role.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rig, type Route } from './brkr.helpers';
import offCycle from '../../pages/api/payroll/runs/off-cycle';
import { todayInSast } from '@/lib/saDateParser';
import { approvalCoveredPaydaySql } from '@/modules/accounting/services/payroll/payrollPaydayCover';

let a: Awaited<ReturnType<typeof rig>>;
let bonusRun = '';
const today = todayInSast();
const [year, month] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];

beforeAll(async () => {
  a = await rig('w6-oc-payday-reopen');
  await a.setup();
  const emp = (await a.employee(15_000)).employee;
  const component = (await a.pool.query(`INSERT INTO payroll_components (company_id, name, sars_source_code, component_type)
    VALUES ($1, 'Annual bonus', '3605', 'earning') RETURNING id`, [a.company])).rows[0].id;
  const regular = await a.calculatedRun(month);
  expect((await a.api.approve(regular)).statusCode).toBe(200);
  const made = await a.call(offCycle as Route, 'POST', '/api/payroll/runs/off-cycle', undefined, {
    body: { month, year, reason: 'bonus', runDate: today, employees: [{ employeeId: emp, componentId: component, amount: 2_000 }] },
  });
  expect(made.statusCode, JSON.stringify(made.body)).toBe(201);
  bonusRun = String(made.body.data!.id);
  expect((await a.api.calculate(bonusRun)).statusCode).toBe(200);
  const ok = await a.api.approve(bonusRun); // approved on payday (today)
  expect(ok.statusCode, JSON.stringify(ok.body)).toBe(200);
}, 180_000);

afterAll(async () => {
  await a.pool.query('DELETE FROM payroll_off_cycle_employees WHERE company_id = $1', [a.company]).catch(() => undefined);
  await a.pool.query('DELETE FROM audit_log WHERE company_id = $1', [a.company]).catch(() => undefined);
  await a.teardown();
}, 120_000);

describe('reopened on payday, corrected the next day', () => {
  // On the 1st the day before is in another month, which an off-cycle run cannot be paid in.
  it.skipIf(today.endsWith('-01'))('the re-approval is 200 and the forecast counts the run as disbursed', async () => {
    const journal = String((await a.pool.query('SELECT journal_entry_id FROM payroll_run_headers WHERE id = $1', [bonusRun])).rows[0].journal_entry_id);
    expect((await a.api.reopen(bonusRun)).statusCode).toBe(200); // reopened on payday
    expect((await a.api.reverse(journal)).statusCode).toBe(200);
    // The next day: the pay date, its frozen payday and the approval history one day earlier, together.
    await a.pool.query(`UPDATE payroll_run_headers SET run_date = run_date - 1, off_cycle_payday_at = off_cycle_payday_at - interval '1 day',
        approval_history = (SELECT range_agg(tstzrange(lower(r) - interval '1 day', upper(r) - interval '1 day', '[)'))
                              FROM unnest(approval_history) r)
      WHERE id = $1`, [bonusRun]);
    const covered = (await a.pool.query(`SELECT ${approvalCoveredPaydaySql('h')} AS d FROM payroll_run_headers h WHERE h.id = $1`, [bonusRun])).rows[0].d;
    expect(covered).toBe(true);
    expect((await a.api.calculate(bonusRun)).statusCode).toBe(200);
    const ok = await a.api.approve(bonusRun);
    expect(ok.statusCode, JSON.stringify(ok.body)).toBe(200);
  });
});
