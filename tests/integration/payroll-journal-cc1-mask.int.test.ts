/**
 * PR #1065 review round 2 (breaker M1/M2, ported). The approval gate compares
 * a recalculated run's labour per (account, CC1); neither of these may hide a
 * real move between two cost centres mapped to one account:
 *
 *  M1  both centres deactivated after posting — the plan now books both
 *      untagged, but it compares per SOURCE centre against the journal's tags;
 *  M2  the journal's labour tags cleared with tag_journal_lines — the gate reads
 *      the CC1 AS POSTED (the tag batch's old_cc1_id), so the journal is not
 *      mistaken for one from before CC1.
 *
 * Real routes (withAuth, app_user, RLS) on the disposable fixture; the tags are
 * cleared through the tag tool's own plan + apply.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withAlsTransaction } from '@/lib/alsTransaction';
import { planDimensionTags } from '@/modules/accounting/services/gl/dimensions/dimensionTagPlan';
import { applyDimensionTags } from '@/modules/accounting/services/gl/dimensions/dimensionTagApply';
import { rig } from './brkr.helpers';

let r: Awaited<ReturnType<typeof rig>>;
let wanda = '';
const cc = { a: crypto.randomUUID(), b: crypto.randomUUID() };
const allocate = async (shares: Array<[string, number]>) => {
  await r.pool.query('DELETE FROM payroll_employee_cost_allocations WHERE employee_id = $1', [wanda]);
  for (const [c, p] of shares) {
    await r.pool.query('INSERT INTO payroll_employee_cost_allocations (company_id, employee_id, cost_centre_id, percentage) VALUES ($1,$2,$3,$4)',
      [r.company, wanda, c, p]);
  }
};
const active = (on: boolean) => r.pool.query('UPDATE cost_centres SET is_active = $1 WHERE id = ANY($2::uuid[])', [on, [cc.a, cc.b]]);
/** A reopened run approved on 60/40, its journal id. */
async function postedOn6040(month: number): Promise<{ id: string; journal: string }> {
  await allocate([[cc.a, 60], [cc.b, 40]]);
  const id = await r.calculatedRun(month);
  const journal = String((await r.api.approve(id)).body.data!.journalEntryId);
  expect((await r.api.reopen(id)).statusCode).toBe(200);
  return { id, journal };
}

beforeAll(async () => {
  r = await rig('cc1mask'); await r.setup();
  const acct5210 = await r.account('5210');
  for (const [id, code] of [[cc.a, 'MSK-A'], [cc.b, 'MSK-B']] as const) {
    await r.pool.query("INSERT INTO cost_centres (id, company_id, code, name, cc_type, is_active) VALUES ($1,$2,$3,$3,'cc1',true)", [id, r.company, code]);
    await r.pool.query('INSERT INTO cost_centre_gl_mappings (company_id, cost_centre_id, expense_account_id) VALUES ($1,$2,$3)', [r.company, id, acct5210]);
  }
  wanda = (await r.employee(20000)).employee;
});
afterAll(async () => { await r.teardown(); });

describe('a move between two centres on one account is not masked', () => {
  it('M1: deactivating both centres after posting does not let a 60/40 → 50/50 move re-lock', async () => {
    const { id } = await postedOn6040(3);
    await allocate([[cc.a, 50], [cc.b, 50]]);
    expect((await r.api.calculate(id)).statusCode).toBe(200);
    expect((await r.api.preview(id)).body.data!.blocker).toMatchObject({ code: 'recalculated_after_posting' });
    await active(false);
    try {
      const p = await r.api.preview(id);
      expect(p.body.data!.blocker).toMatchObject({ code: 'recalculated_after_posting' });
      // The breakdown it compared with is the gate's own: never in the preview.
      expect(p.body.data!.plan).not.toHaveProperty('labourBySourceCentre');
    } finally { await active(true); }
  });

  it('M1 control: both deactivated and NOTHING changed re-locks onto the journal', async () => {
    const { id, journal } = await postedOn6040(4);
    await active(false);
    try {
      expect((await r.api.calculate(id)).statusCode).toBe(200);
      expect((await r.api.preview(id)).body.data!.blocker).toBeNull();
      expect((await r.api.approve(id)).body.data).toMatchObject({ journalEntryId: journal });
    } finally { await active(true); }
  });

  it('M2: labour tags cleared with tag_journal_lines — an unchanged run re-locks, a move is still refused', async () => {
    const { id, journal } = await postedOn6040(5);
    const lines = (await r.pool.query<{ id: string }>(
      'SELECT id::text AS id FROM gl_journal_lines WHERE journal_entry_id = $1 AND cc1_id IS NOT NULL ORDER BY id', [journal])).rows;
    expect(lines).toHaveLength(2);
    await withAlsTransaction({ companyId: r.company, userId: r.admin }, async () => {
      const plan = await planDimensionTags(r.company, lines.map((l) => ({ journalLineId: l.id, cc1: null, unallocatedReason: 'cc1 review M2' })));
      await applyDimensionTags(r.company, plan, { idempotencyKey: `m2-${journal}`, userId: r.admin });
    });
    expect((await r.pool.query('SELECT count(*)::int AS n FROM gl_journal_lines WHERE journal_entry_id = $1 AND cc1_id IS NOT NULL', [journal])).rows[0]!.n).toBe(0);

    expect((await r.api.calculate(id)).statusCode).toBe(200);
    expect((await r.api.preview(id)).body.data!.blocker).toBeNull();

    await allocate([[cc.a, 50], [cc.b, 50]]);
    expect((await r.api.calculate(id)).statusCode).toBe(200);
    expect((await r.api.preview(id)).body.data!.blocker).toMatchObject({ code: 'recalculated_after_posting' });
  });
});
