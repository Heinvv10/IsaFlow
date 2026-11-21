/**
 * Gate ruling 1 on e0eec1dea1: a regular line costed before the onceOff marker (calculation_version < 20) is rebuilt for
 * an off-cycle line's classification by recovering each unflagged basic pay item's assignment (the employee's
 * payroll_employee_components row of that component and amount, active over the month): a once-off one is not
 * time-worked pay. When it cannot be recovered, the line's own stored class stands (storedClass).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { rig, type Route } from './brkr.helpers';
import offCycle from '../../pages/api/payroll/runs/off-cycle';
import { loadMonthEarlierLines } from '@/modules/accounting/services/payroll/payrollOffCycleMonthRead';

vi.useFakeTimers({ now: new Date('2026-11-17T08:00:00Z'), shouldAdvanceTime: true, toFake: ['Date'] });

let a: Awaited<ReturnType<typeof rig>>;
let emp = '';
let flatEmp = '';
let directedEmp = '';
let onceOffRow = '';
let basic = '';
let regular = '';
let bonusRun = '';

beforeAll(async () => {
  a = await rig('w6-oc-historic');
  await a.setup();
  emp = (await a.employee(12_000)).employee;
  basic = String((await a.pool.query(`SELECT id FROM payroll_components WHERE company_id = $1 AND name = 'Basic Salary'`, [a.company])).rows[0].id);
  onceOffRow = String((await a.pool.query(`INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from, effective_to, is_recurring)
    VALUES ($1, $2, 1517, '2026-11-01', '2026-11-30', false) RETURNING id`, [emp, basic])).rows[0].id);
  // Review L2 of f37f0f15a6: a real flat regular line (under 6 hours a day: non-standard, G21 p. 28) and a real line
  // under a regular-pay directive, each with a once-off basic pay item that is later lost (unrecoverable).
  flatEmp = (await a.employee(9_000)).employee;
  await a.pool.query('UPDATE payroll_employees SET hours_per_week = 20, hours_per_day = 4 WHERE id = $1', [flatEmp]);
  directedEmp = (await a.employee(20_000)).employee;
  await a.pool.query(`INSERT INTO tax_directives (company_id, employee_id, employee_name, directive_type, amount, tax_rate, effective_date, status)
    VALUES ($1, $2, 'Directed', 'fixed_percentage', 0, 0.25, '2026-03-01', 'approved')`, [a.company, directedEmp]);
  for (const who of [flatEmp, directedEmp]) {
    await a.pool.query(`INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from, effective_to, is_recurring)
      VALUES ($1, $2, 700, '2026-11-01', '2026-11-30', false)`, [who, basic]);
  }
  const bonus = (await a.pool.query(`INSERT INTO payroll_components (company_id, name, sars_source_code, component_type)
    VALUES ($1, 'Annual bonus', '3605', 'earning') RETURNING id`, [a.company])).rows[0].id;
  regular = await a.calculatedRun(11);
  expect((await a.api.approve(regular)).statusCode).toBe(200);
  const made = await a.call(offCycle as Route, 'POST', '/api/payroll/runs/off-cycle', undefined, {
    body: { month: 11, year: 2026, reason: 'bonus', runDate: '2026-11-25', employees: [{ employeeId: emp, componentId: bonus, amount: 2_000 }] },
  });
  expect(made.statusCode, JSON.stringify(made.body)).toBe(201);
  bonusRun = String(made.body.data!.id);
  // The regular line as a release before the marker costed it: no onceOff on any item, an older calculation version.
  await a.pool.query(`UPDATE payroll_run_lines SET component_breakdown = (SELECT jsonb_agg(item - 'onceOff') FROM jsonb_array_elements(component_breakdown) item)
    WHERE run_id = $1`, [regular]);
  await a.pool.query('UPDATE payroll_run_headers SET calculation_version = 19 WHERE id = $1', [regular]);
}, 180_000);

afterAll(async () => {
  await a.pool.query('DELETE FROM payroll_run_directive_uses WHERE directive_id IN (SELECT id FROM tax_directives WHERE company_id = $1)', [a.company]).catch(() => undefined);
  await a.pool.query('DELETE FROM tax_directive_payments WHERE company_id = $1', [a.company]).catch(() => undefined);
  await a.pool.query('DELETE FROM tax_directives WHERE company_id = $1', [a.company]).catch(() => undefined);
  await a.pool.query('DELETE FROM payroll_off_cycle_employees WHERE company_id = $1', [a.company]).catch(() => undefined);
  await a.pool.query('DELETE FROM audit_log WHERE company_id = $1', [a.company]).catch(() => undefined);
  await a.teardown();
  vi.useRealTimers();
}, 120_000);

describe('a historical regular line in the month', () => {
  it('its once-off basic pay is recovered from the assignment and does not count as time worked', async () => {
    const line = (await a.pool.query('SELECT component_breakdown AS b FROM payroll_run_lines WHERE run_id = $1', [regular])).rows[0].b as Array<Record<string, unknown>>;
    expect(line.some((i) => 'onceOff' in i)).toBe(false);
    const earlier = (await loadMonthEarlierLines(a.company, bonusRun, [emp])).get(emp)!;
    const basics = earlier.etiComponents.filter((c) => c.component.sarsSourceCode.trim() === '3601');
    expect(basics.find((c) => c.amount === 1517)?.isRecurring).toBe(false);
    expect(basics.find((c) => c.amount === 12_000)?.isRecurring).not.toBe(false);
    expect(earlier.storedClass).toBeUndefined();
  });
  it('when the assignment cannot be recovered, the line\'s stored class stands', async () => {
    await a.pool.query('DELETE FROM payroll_employee_components WHERE id = $1', [onceOffRow]);
    const earlier = (await loadMonthEarlierLines(a.company, bonusRun, [emp])).get(emp)!;
    expect(earlier.storedClass).toBe('tables');
  });
  it('a recurring row of the same amount added after the line was calculated is not its assignment (review L3)', async () => {
    await a.pool.query(`INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from, is_recurring)
      VALUES ($1, $2, 1517, '2026-11-01', true)`, [emp, basic]);
    const earlier = (await loadMonthEarlierLines(a.company, bonusRun, [emp])).get(emp)!;
    expect(earlier.storedClass).toBe('tables');
  });
  it('the stored class keeps a flat line flat and a directive line on its directive (review L2)', async () => {
    await a.pool.query(`DELETE FROM payroll_employee_components WHERE employee_id = ANY($1::uuid[]) AND NOT is_recurring`, [[flatEmp, directedEmp]]);
    const earlier = await loadMonthEarlierLines(a.company, bonusRun, [flatEmp, directedEmp]);
    expect(earlier.get(flatEmp)?.storedClass).toBe('flat');
    const paye = (await a.pool.query(`SELECT l.explanation->'paye' AS p FROM payroll_run_lines l WHERE l.run_id = $1 AND l.employee_id = $2`, [regular, directedEmp])).rows[0]?.p;
    expect(JSON.stringify(paye), 'the regular line was costed under the directive').toMatch(/paye\.regularDirective/);
    expect(earlier.get(directedEmp)?.storedClass).toBe('directive');
  });
});
