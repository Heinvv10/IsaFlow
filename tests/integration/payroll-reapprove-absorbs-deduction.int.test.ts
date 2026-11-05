/**
 * Breaker L2-1, end to end (real routes, disposable fixture). A reopened run whose
 * 2175 deduction was removed and recalculated (net pay up by exactly that amount,
 * gross/PAYE/UIF/SDL unchanged) must be refused `recalculated_after_posting`: the
 * journal in force still books the R500 deduction liability and credits bank
 * R500 short. Before the fix the gate folds the posted 2175 credit into "the bank"
 * (the plan no longer uses 2175), the bucket sums match, and the run re-locks.
 * No bank-role move is needed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rig } from './brkr.helpers';

let r: Awaited<ReturnType<typeof rig>>;
let unionFee = '';

const credits = async (journalId: string): Promise<Record<string, number>> => Object.fromEntries((await r.pool.query(
  `SELECT a.account_code, round(l.credit * 100)::int AS c FROM gl_journal_lines l JOIN gl_accounts a ON a.id = l.gl_account_id
    WHERE l.journal_entry_id = $1 AND l.credit > 0`, [journalId])).rows.map((x) => [x.account_code, x.c]));
const totals = async (id: string) => (await r.pool.query(
  'SELECT total_gross::float8 g, total_paye::float8 p, total_uif::float8 u, total_sdl::float8 s, total_net::float8 n FROM payroll_run_headers WHERE id = $1', [id])).rows[0];

beforeAll(async () => {
  r = await rig('l2-absorb');
  await r.setup();
  const { employee } = await r.employee(20000);
  const comp = (await r.pool.query(
    `INSERT INTO payroll_components (company_id, name, sars_source_code, component_type, is_taxable, is_uif_applicable, is_sdl_applicable)
     VALUES ($1, 'Union fee', '4497', 'deduction', false, false, false) RETURNING id`, [r.company])).rows[0]!.id;
  await r.pool.query(
    `INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from) VALUES ($1, $2, 500, '2020-01-01')`,
    [employee, comp]);
  unionFee = comp;
});
afterAll(async () => { await r.teardown(); });

describe('re-approval after a deduction was removed', () => {
  it('refuses: the in-force journal still books the removed deduction', async () => {
    const id = await r.calculatedRun(1);
    const before = await totals(id);
    const first = await r.api.approve(id);
    expect(first.statusCode).toBe(200);
    const j1 = String(first.body.data!.journalEntryId);
    const c1 = await credits(j1);
    expect(c1['2175']).toBe(50000);
    expect((await r.api.reopen(id)).statusCode).toBe(200);

    await r.pool.query('DELETE FROM payroll_employee_components WHERE component_id = $1', [unionFee]);
    expect((await r.api.calculate(id)).statusCode).toBe(200);
    const after = await totals(id);
    // Only the deduction moved into net pay.
    expect([after.g, after.p, after.u, after.s]).toEqual([before.g, before.p, before.u, before.s]);
    expect(Math.round((after.n - before.n) * 100)).toBe(50000);

    const p = await r.api.preview(id);
    const again = await r.api.approveWith(id, p.body.data!.planHash);
    expect(p.body.data!.blocker).toMatchObject({ code: 'recalculated_after_posting' });
    expect(again.statusCode).toBe(400);
  });
});
