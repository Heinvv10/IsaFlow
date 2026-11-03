/**
 * The pay-run grid as a writer of payroll_employee_components under master's #1117 rules (merge of 2026-11-04):
 *  - it leaves an audit row per write (payrollComponentAudit, kind run_input / run_input_remove), in the same
 *    savepoint and before the recalculation stamps the run, so the approval gate's "changed after calculation"
 *    check (payrollRunRecalcGate) does not refuse the run the grid just recalculated;
 *  - it reads the run's month on the run's own read day (payrollRunReadDate, the period's last day): a once-off the
 *    run pays from the 29th is a conflict on the grid, not an empty cell beside which a second row would be added.
 * Disposable fixture DB only.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { inputsFixture } from './payrun-period-inputs.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const fx = inputsFixture(pool);
const { state, set, get, rows, preview, doApprove, addRow } = fx;
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

  it('audits a removal (amount nil) too', async () => {
    await set(state.nov, comp.overtime!, 1000);
    expect((await set(state.nov, comp.overtime!, 0)).statusCode).toBe(200);
    expect(await rows(comp.overtime!)).toEqual([]);
    expect((await audits()).map((a) => a.kind)).toEqual(['run_input', 'run_input_remove']);
  });

  it('reads on the run\'s last day: a once-off the run pays from the 29th is a conflict, never a cell to add beside', async () => {
    await addRow(comp.overtime!, 800, '2026-11-29', '2026-11-30');
    const inputs = (await get(state.nov)).body.data!.inputs as { amounts: Array<{ componentId: string; conflict: boolean }> };
    expect(inputs.amounts.find((a) => a.componentId === comp.overtime)).toMatchObject({ conflict: true });
    expect((await set(state.nov, comp.overtime!, 500, state.employee, 0)).statusCode).toBe(409);
    expect(await rows(comp.overtime!)).toHaveLength(1);
  });
});
