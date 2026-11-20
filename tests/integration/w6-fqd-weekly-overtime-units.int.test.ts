/**
 * Wave 6 FQd x RI (#1580, F2): a weekly salaried employee's overtime hours through the real chain, now that weekly runs
 * are costed. PUT /api/payroll/runs/[id]/inputs with { units: overtime } prices the hours at the WEEKLY hourly rate,
 * weekly basic / hours a week (R2 000 / 40 = R50), never on a month's weeks (52 / 12); calculate pays it on the line.
 *
 * Disposable DB only (rig -> assertDisposable).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rig, type Route } from './brkr.helpers';
import { cleanup, type R } from './pe-payslip-email.helpers';
import runs from '../../pages/api/payroll/runs';
import inputs from '../../pages/api/payroll/runs/[id]/inputs';
import payFrequency from '../../pages/api/payroll/employees/[id]/pay-frequency';

let a: R;
let employee = '';
let run = '';

beforeAll(async () => {
  a = await rig('fqd-weekly-overtime');
  await a.setup();
  ({ employee } = await a.employee(2000)); // R2 000 a week
  await a.pool.query('UPDATE payroll_employees SET hours_per_week = 40 WHERE id = $1', [employee]);
  expect((await a.call(payFrequency as Route, 'PUT', `/api/payroll/employees/${employee}/pay-frequency`, employee,
    { body: { payFrequency: 'weekly' } })).statusCode).toBe(200);
  await a.pool.query(`INSERT INTO payroll_components (company_id, name, sars_source_code, component_type, is_taxable)
    VALUES ($1, 'Overtime', '3607', 'earning', true)`, [a.company]);
  run = String((await a.call(runs as Route, 'POST', '/api/payroll/runs', undefined,
    { body: { frequency: 'weekly', periodStart: '2027-01-04' } })).body.data!.id);
}, 240_000);
afterAll(async () => { await cleanup(a); });

describe('weekly overtime units (RI) on a weekly run', () => {
  it('10 hours at 1.5x are priced on the weekly rate, R2 000 / 40 = R50 an hour: R750', async () => {
    const res = await a.call(inputs as Route, 'PUT', `/api/payroll/runs/${run}/inputs`, run,
      { body: { employeeId: employee, units: { kind: 'overtime', multiplier: 1.5, quantity: 10, ratePerKm: null, expectedQuantity: null } } });
    expect(res.statusCode, a.msg(res) ?? '').toBe(200);
    const rates = (res.body.data as { inputs?: { units?: { rates?: unknown } } } | undefined)?.inputs?.units?.rates
      ?? (res.body.data as { units?: { rates?: unknown } } | undefined)?.units?.rates;
    expect(rates).toEqual([{ employeeId: employee, hourlyRate: 50 }]);
    const stored = (await a.pool.query(`SELECT pec.amount::float8 AS amount, pec.quantity::float8 AS quantity, pec.rate_multiplier::float8 AS m
      FROM payroll_employee_components pec JOIN payroll_components c ON c.id = pec.component_id
     WHERE pec.employee_id = $1 AND c.sars_source_code = '3607'`, [employee])).rows;
    expect(stored).toEqual([{ amount: 750, quantity: 10, m: 1.5 }]);
  });

  it('calculate pays the week\'s basic and the overtime on the line: gross R2 750', async () => {
    const c = await a.api.calculate(run);
    expect(c.statusCode, a.msg(c) ?? '').toBe(200);
    const line = (await a.pool.query('SELECT gross_pay::float8 AS gross, component_breakdown FROM payroll_run_lines WHERE run_id = $1 AND employee_id = $2',
      [run, employee])).rows[0]!;
    expect(line.gross).toBe(2750);
    const ot = (line.component_breakdown as Array<{ sarsSourceCode?: string; amount?: number; rateMultiplier?: number }>)
      .filter((i) => i.sarsSourceCode === '3607').map((i) => [i.amount, i.rateMultiplier]);
    expect(ot).toEqual([[750, 1.5]]);
  });
});
