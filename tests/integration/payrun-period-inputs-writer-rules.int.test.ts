/**
 * The pay-run grid as a writer of payroll_employee_components under master's #1117 rules (merge of 2026-11-04):
 *  - it leaves an audit row per write (payrollComponentAudit, kind run_input / run_input_remove), in the same
 *    savepoint and before the recalculation stamps the run, so the approval gate's "changed after calculation"
 *    check (payrollRunRecalcGate) does not refuse the run the grid just recalculated;
 *  - it reads the run's month on the run's own read day (payrollRunReadDate, the period's last day): a once-off the
 *    run pays from the 29th is a conflict on the grid, not an empty cell beside which a second row would be added; and
 *    through the run's own reader, so a row the reader does not pay (superseded) is no conflict;
 *  - a removal is audited as a 'delete' naming the employee, so the approval gate sees it after the row is gone;
 *  - a reopened run whose journal is still in force is not edited at all: its month was costed on those rows.
 * Disposable fixture DB only.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import reopen from '../../pages/api/payroll/runs/[id]/reopen';
import type { Route } from './w3-01-payroll.helpers';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { inputsFixture } from './payrun-period-inputs.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const fx = inputsFixture(pool);
const { state, set, get, rows, line, preview, doApprove, addRow, recalculate, call } = fx;
const comp = state.comp;

beforeAll(fx.setUp);
beforeEach(fx.freshCompany);
afterEach(fx.dropCompany);
afterAll(fx.tearDown);

const audits = async () => (await pool.query(
  `SELECT entity_id::text AS id, user_id, action, changes->'metadata'->>'kind' AS kind
     FROM audit_log WHERE company_id = $1 AND entity_type = 'payroll_employee_component' ORDER BY created_at`, [state.coA])).rows;

describe('the pay-run grid as a component writer (#1117)', () => {
  it('audits each write as the user who made it, and the run it recalculated still approves', async () => {
    expect((await set(state.nov, comp.overtime!, 1000)).statusCode).toBe(200);
    const [row] = await rows(comp.overtime!) as Array<{ id: string }>;
    expect((await set(state.nov, comp.overtime!, 1500)).statusCode).toBe(200);
    expect(await audits()).toEqual([
      { id: row!.id, user_id: fx.admin, action: 'create', kind: 'run_input' },
      { id: row!.id, user_id: fx.admin, action: 'update', kind: 'run_input' },
    ]);
    const { blocker, planHash } = (await preview(state.nov)).body.data!;
    expect(blocker).toBeNull();
    expect((await doApprove(state.nov, planHash)).statusCode).toBe(200);
  });

  it('audits a removal as a delete naming the employee, which the approval gate then sees', async () => {
    await set(state.nov, comp.overtime!, 1000);
    expect((await set(state.nov, comp.overtime!, 0)).statusCode).toBe(200);
    expect(await rows(comp.overtime!)).toEqual([]);
    expect((await audits()).map((a) => [a.kind, a.action])).toEqual([['run_input', 'create'], ['run_input_remove', 'delete']]);
    const removed = (await pool.query(
      `SELECT changes->'metadata'->>'employeeId' AS employee FROM audit_log WHERE company_id = $1 AND action = 'delete'`, [state.coA])).rows;
    expect(removed).toEqual([{ employee: state.employee }]);
    // Had the run been calculated before the removal, approval must say so, though the row is gone.
    await pool.query(`UPDATE payroll_run_headers SET calculated_at = calculated_at - interval '1 hour' WHERE id = $1`, [state.nov]);
    expect((await preview(state.nov)).body.data!.blocker).toMatchObject({ code: 'components_changed_after_calculation' });
  });

  it('a reopened run whose journal is in force: an edit and a removal are both refused, the row unchanged', async () => {
    await set(state.nov, comp.overtime!, 1000);
    const { planHash } = (await preview(state.nov)).body.data!;
    expect((await doApprove(state.nov, planHash)).statusCode).toBe(200);
    expect((await call(reopen as Route, 'POST', `/api/payroll/runs/${state.nov}/reopen`, state.nov, { body: { reason: 'grid H1' } })).statusCode).toBe(200);
    for (const amount of [1500, 0]) {
      const res = await set(state.nov, comp.overtime!, amount, state.employee, 1000);
      expect(res.statusCode, JSON.stringify(res.body)).toBe(400);
      expect(res.body.error?.message).toContain('Reverse the payroll journal first');
    }
    expect(await rows(comp.overtime!)).toMatchObject([{ amount: 1000 }]);
  });

  it('reads through the run\'s reader: a once-off a package superseded is not paid, so the cell is free', async () => {
    // A once-off dated in the month is paid whatever its end, unless superseded (a package cut it, superseded_at). A
    // calendar window over the month would match this row and call the cell a conflict; the run does not pay it.
    await addRow(comp.overtime!, 700, '2026-11-01', '2026-11-14');
    await pool.query(`UPDATE payroll_employee_components SET superseded_at = now() WHERE component_id = $1`, [comp.overtime]);
    await recalculate(state.nov);
    const inputs = (await get(state.nov)).body.data!.inputs as { amounts: Array<{ componentId: string }> };
    expect(inputs.amounts.filter((a) => a.componentId === comp.overtime)).toEqual([]);
    const before = (await line(state.nov)).gross;
    expect((await set(state.nov, comp.overtime!, 300, state.employee, 0)).statusCode).toBe(200);
    expect((await line(state.nov)).gross).toBeCloseTo(before + 300, 2);
  });

  it('reads on the run\'s last day: a once-off the run pays from the 29th is a conflict, never a cell to add beside', async () => {
    await addRow(comp.overtime!, 800, '2026-11-29', '2026-11-30');
    const inputs = (await get(state.nov)).body.data!.inputs as { amounts: Array<{ componentId: string; conflict: boolean }> };
    expect(inputs.amounts.find((a) => a.componentId === comp.overtime)).toMatchObject({ conflict: true });
    expect((await set(state.nov, comp.overtime!, 500, state.employee, 0)).statusCode).toBe(409);
    expect(await rows(comp.overtime!)).toHaveLength(1);
  });
});
