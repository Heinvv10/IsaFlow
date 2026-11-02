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
 *
 * Round 3 (T1): when a line's earliest tag history is not ONE row — two batches
 * of one transaction share created_at (an MCP JSON-RPC batch runs in one), or a
 * batch lists the line twice — which CC1 it was posted with cannot be told, so
 * the gate fails closed. The tie is written directly (ids chosen so the old id
 * tie-break picks the WRONG row), so the test is deterministic.
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

  it('T1: two tag batches tied on created_at — the as-posted CC1 is unknown, so a move is refused', async () => {
    await allocate([[cc.a, 60], [cc.b, 40]]);
    const id = await r.calculatedRun(6);
    const journal = String((await r.api.approve(id)).body.data!.journalEntryId);
    expect((await r.api.reopen(id)).statusCode).toBe(200);
    const lineA = (await r.pool.query('SELECT id::text AS id FROM gl_journal_lines WHERE journal_entry_id = $1 AND cc1_id = $2', [journal, cc.a])).rows[0]!.id;
    // A → B then B → A in one transaction: the ledger is as posted, the history ties. The SECOND batch
    // (old B) gets the lower id, so ordering by id reads "posted with B" — and 100% B would match it.
    const [second, first] = ['00000000-0000-4000-8000-000000000001', 'ffffffff-ffff-4fff-bfff-ffffffffffff'];
    for (const [batch, oldCc, newCc] of [[first, cc.a, cc.b], [second, cc.b, cc.a]] as const) {
      await r.pool.query(`INSERT INTO dimension_tag_batches (id, company_id, idempotency_key, line_count, created_by, created_at)
                          VALUES ($1, $2, $3, 1, $4, '2026-11-02 10:00:00+00')`, [batch, r.company, `t1-${batch}-${journal}`, r.admin]);
      await r.pool.query(`INSERT INTO dimension_tag_batch_lines (batch_id, company_id, journal_line_id, old_cc1_id, new_cc1_id)
                          VALUES ($1, $2, $3, $4, $5)`, [batch, r.company, lineA, oldCc, newCc]);
    }
    try {
      await allocate([[cc.b, 100]]);
      expect((await r.api.calculate(id)).statusCode).toBe(200);
      expect((await r.api.preview(id)).body.data!.blocker).toMatchObject({ code: 'recalculated_after_posting' });
    } finally {
      await r.pool.query('DELETE FROM dimension_tag_batches WHERE id = ANY($1::uuid[])', [[first, second]]);
    }
  });

  it('T1: one batch listing the line twice is treated the same way', async () => {
    await allocate([[cc.a, 60], [cc.b, 40]]);
    const id = await r.calculatedRun(7);
    const journal = String((await r.api.approve(id)).body.data!.journalEntryId);
    expect((await r.api.reopen(id)).statusCode).toBe(200);
    const lineA = (await r.pool.query('SELECT id::text AS id FROM gl_journal_lines WHERE journal_entry_id = $1 AND cc1_id = $2', [journal, cc.a])).rows[0]!.id;
    const batch = crypto.randomUUID();
    await r.pool.query('INSERT INTO dimension_tag_batches (id, company_id, idempotency_key, line_count, created_by) VALUES ($1, $2, $3, 2, $4)',
      [batch, r.company, `t1dup-${journal}`, r.admin]);
    await r.pool.query(`INSERT INTO dimension_tag_batch_lines (batch_id, company_id, journal_line_id, old_cc1_id, new_cc1_id)
                        VALUES ($1, $2, $3, $4, $5), ($1, $2, $3, $5, $4)`, [batch, r.company, lineA, cc.b, cc.a]);
    try {
      await allocate([[cc.b, 100]]);
      expect((await r.api.calculate(id)).statusCode).toBe(200);
      expect((await r.api.preview(id)).body.data!.blocker).toMatchObject({ code: 'recalculated_after_posting' });
      // Unchanged figures are refused too: fail closed, the history cannot say what was posted.
      await allocate([[cc.a, 60], [cc.b, 40]]);
      expect((await r.api.calculate(id)).statusCode).toBe(200);
      expect((await r.api.preview(id)).body.data!.blocker).toMatchObject({ code: 'recalculated_after_posting' });
    } finally {
      await r.pool.query('DELETE FROM dimension_tag_batches WHERE id = $1', [batch]);
    }
  });
});
