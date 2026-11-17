/**
 * Overtime hours and travel km on a pay run (wave 6 RI, migration 999t) through the real chain: PUT /api/payroll/runs/[id]/inputs
 * with { employeeId, units: { kind, multiplier, quantity, ratePerKm, expectedQuantity } }. The amount is priced on the server and
 * stored on the run month's once-off row with its quantity, unit and multiplier; the calculation splits a km row at the prescribed
 * rate (R4.95 a km in tax year 2027). Two tenants: company B's run is never reached from company A. Disposable fixture DB only.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { inputsFixture } from './payrun-period-inputs.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const fx = inputsFixture(pool);
const { state, put, line } = fx;
const ctx = { travel: '' };

const units = (run: string, u: Record<string, unknown>, employeeId = state.employee) =>
  put(run, { employeeId, units: { multiplier: null, ratePerKm: null, expectedQuantity: null, ...u } });
const stored = async () => (await pool.query(
  `SELECT c.sars_source_code AS code, pec.amount::float8 AS amount, pec.quantity::float8 AS quantity, pec.quantity_unit AS unit,
          pec.rate_multiplier::float8 AS multiplier
     FROM payroll_employee_components pec JOIN payroll_components c ON c.id = pec.component_id
    WHERE pec.employee_id = $1 AND NOT pec.is_recurring ORDER BY c.sars_source_code, pec.rate_multiplier`, [state.employee])).rows;
const item = (l: { component_breakdown: Array<Record<string, unknown>> }, code: string) => l.component_breakdown.filter((i) => i.sarsSourceCode === code);

beforeAll(fx.setUp);
beforeEach(async () => {
  await fx.freshCompany();
  // 40 hours a week beside the R20 000 Basic Salary: overtime is priced at 20 000 / (40 x 52 / 12) = R115.38 an hour.
  await pool.query('UPDATE payroll_employees SET hours_per_week = 40 WHERE id = $1', [state.employee]);
  ctx.travel = await fx.addComponent(state.coA, 'Travel reimbursement', '3703', 'earning', false);
});
afterEach(fx.dropCompany);
afterAll(fx.tearDown);

describe('overtime: hours x hourly rate x multiplier, priced on the server (BCEA s10(2), s16(1))', () => {
  it('stores each multiplier as its own row, pays both on the line, and leaves the amount cells alone', async () => {
    const res = await units(state.nov, { kind: 'overtime', multiplier: 1.5, quantity: 10 });
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect((await units(state.nov, { kind: 'overtime', multiplier: 2, quantity: 8 })).statusCode).toBe(200);
    // 10 h x 115.38 x 1.5 = 1 730.70; 8 h x 115.38 x 2 = 1 846.08.
    expect(await stored()).toEqual([
      { code: '3607', amount: 1730.7, quantity: 10, unit: 'hour', multiplier: 1.5 },
      { code: '3607', amount: 1846.08, quantity: 8, unit: 'hour', multiplier: 2 },
    ]);
    const l = await line(state.nov);
    expect(l.gross).toBe(23576.78);
    expect(item(l, '3607').map((i) => [i.amount, i.quantity, i.rateMultiplier]).sort((a, b) => Number(a[2]) - Number(b[2]))).toEqual([[1730.7, 10, 1.5], [1846.08, 8, 2]]);
    const last = (await fx.get(state.nov)).body.data!.inputs;
    expect(last.amounts.filter((a: { componentId: string }) => a.componentId === state.comp.overtime)).toEqual([]);
    expect(last.units.rows).toEqual([
      { employeeId: state.employee, kind: 'overtime', multiplier: 1.5, quantity: 10, amount: 1730.7 },
      { employeeId: state.employee, kind: 'overtime', multiplier: 2, quantity: 8, amount: 1846.08 },
    ]);
    expect(last.units.rates).toEqual([{ employeeId: state.employee, hourlyRate: 115.38 }]);
  });

  it('a stale expectedQuantity is 409 and changes nothing; null clears the row', async () => {
    await units(state.nov, { kind: 'overtime', multiplier: 1.5, quantity: 10 });
    const stale = await units(state.nov, { kind: 'overtime', multiplier: 1.5, quantity: 12, expectedQuantity: 9 });
    expect(stale.statusCode).toBe(409);
    expect((await stored())[0]).toMatchObject({ quantity: 10, amount: 1730.7 });
    expect((await units(state.nov, { kind: 'overtime', multiplier: 1.5, quantity: null, expectedQuantity: 10 })).statusCode).toBe(200);
    expect(await stored()).toEqual([]);
    expect((await line(state.nov)).gross).toBe(20000);
  });

  it('refuses before any write: a multiplier other than 1.5 or 2, no hourly rate, an employee of another company', async () => {
    expect((await units(state.nov, { kind: 'overtime', multiplier: 3, quantity: 10 })).statusCode).toBe(400);
    expect((await units(state.nov, { kind: 'travel', multiplier: 1.5, quantity: 10, ratePerKm: 4 })).statusCode).toBe(400);
    await pool.query('UPDATE payroll_employees SET hours_per_week = NULL WHERE id = $1', [state.employee]);
    const noRate = await units(state.nov, { kind: 'overtime', multiplier: 1.5, quantity: 10 });
    expect(noRate.statusCode).toBe(400);
    expect(JSON.stringify(noRate.body)).toContain('hours a week');
    expect((await units(state.nov, { kind: 'overtime', multiplier: 1.5, quantity: 10 }, state.employeeB)).statusCode).toBe(400);
    expect(await stored()).toEqual([]);
    expect((await pool.query('SELECT count(*)::int AS n FROM payroll_employee_components WHERE employee_id = $1 AND NOT is_recurring', [state.employeeB])).rows[0]!.n).toBe(0);
  });

  it("company B's run is 404 from company A, and B's rows are untouched", async () => {
    const res = await units(state.runB, { kind: 'overtime', multiplier: 1.5, quantity: 10 }, state.employeeB);
    expect(res.statusCode).toBe(404);
    expect((await pool.query('SELECT count(*)::int AS n FROM payroll_employee_components WHERE employee_id = $1 AND NOT is_recurring', [state.employeeB])).rows[0]!.n).toBe(0);
  });

  it('a malformed body is 400: unknown key, wrong kind, a string quantity', async () => {
    expect((await put(state.nov, { employeeId: state.employee, units: { kind: 'overtime', multiplier: 1.5, quantity: 1, expectedQuantity: null, extra: 1 } })).statusCode).toBe(400);
    expect((await units(state.nov, { kind: 'bonus', quantity: 1 })).statusCode).toBe(400);
    expect((await units(state.nov, { kind: 'overtime', multiplier: 1.5, quantity: '10' })).statusCode).toBe(400);
    expect(await stored()).toEqual([]);
  });
});

describe('travel: km x the rate a km, split at the prescribed R4.95 (tax year 2027)', () => {
  it('above the rate: R4 950 is not taxed (3702), the R1 050 excess is (3722)', async () => {
    const res = await units(state.nov, { kind: 'travel', quantity: 1000, ratePerKm: 6 });
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect(await stored()).toEqual([{ code: '3703', amount: 6000, quantity: 1000, unit: 'km', multiplier: null }]);
    const l = await line(state.nov);
    expect(l.gross).toBe(26000);
    expect(l.taxable).toBe(21050);
    expect(item(l, '3702')).toMatchObject([{ amount: 4950, isTaxable: false, quantity: 1000, quantityUnit: 'km' }]);
    expect(item(l, '3722')).toMatchObject([{ amount: 1050, isTaxable: true }]);
    expect(item(l, '3703')).toEqual([]);
  });

  it('within the rate and nothing else paid: all of it is 3703, not taxed', async () => {
    expect((await units(state.nov, { kind: 'travel', quantity: 1000, ratePerKm: 4 })).statusCode).toBe(200);
    const l = await line(state.nov);
    expect(l.taxable).toBe(20000);
    expect(item(l, '3703')).toMatchObject([{ amount: 4000, isTaxable: false }]);
    expect(item(l, '3722')).toEqual([]);
  });

  it('km to date: the tax year\'s km rows to this month are summed and shown, and the tax ignores them (no km threshold)', async () => {
    // 8 000 km in June 2026, the same tax year (from 1 March 2026), and 500 km in February 2026, the year before.
    for (const [km, from, to] of [[8000, '2026-06-01', '2026-06-30'], [500, '2026-02-01', '2026-02-28']] as const) {
      await pool.query(`INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from, effective_to, is_recurring, quantity, quantity_unit)
                        VALUES ($1, $2, $3, $4, $5, FALSE, $6, 'km')`, [state.employee, ctx.travel, km * 4, from, to, km]);
    }
    expect((await units(state.nov, { kind: 'travel', quantity: 1000, ratePerKm: 4 })).statusCode).toBe(200);
    const res = await fx.get(state.nov);
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    const shown = (res.body as { data: { inputs: { units: { kmToDate: unknown } } } }).data.inputs.units.kmToDate;
    expect(shown).toEqual([{ employeeId: state.employee, km: 9000 }]);
    expect((await fx.get(state.runB)).statusCode).toBe(404);
    const l = await line(state.nov);
    expect(l.taxable).toBe(20000);
    expect(item(l, '3703')).toMatchObject([{ amount: 4000, isTaxable: false }]);
  });

  it('refuses km with no rate a km, and a rate above R100', async () => {
    expect((await units(state.nov, { kind: 'travel', quantity: 1000 })).statusCode).toBe(400);
    expect((await units(state.nov, { kind: 'travel', quantity: 1000, ratePerKm: 101 })).statusCode).toBe(400);
    expect(await stored()).toEqual([]);
  });
});
