/**
 * Re-approving a reopened run that was NOT recalculated, after a cost centre was
 * put on one of its journal's CREDIT lines with tag_journal_lines. The gate
 * compares such a run with the journal as it stands now, and the credit line's
 * new CC1 (the plan never tags a credit) read as a difference:
 * `recalculated_after_posting` on a run that had not changed. Retagging the
 * ledger is not the run changing; a changed figure still is.
 * Real routes (withAuth, app_user, RLS) on the disposable fixture.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withAlsTransaction } from '@/lib/alsTransaction';
import { planDimensionTags } from '@/modules/accounting/services/gl/dimensions/dimensionTagPlan';
import { applyDimensionTags } from '@/modules/accounting/services/gl/dimensions/dimensionTagApply';
import { rig } from './brkr.helpers';

let r: Awaited<ReturnType<typeof rig>>;
let salaryRow = '';
const centre = crypto.randomUUID();

beforeAll(async () => {
  r = await rig('creditretag'); await r.setup();
  await r.pool.query("INSERT INTO cost_centres (id, company_id, code, name, cc_type, is_active) VALUES ($1,$2,'RTG-1','RTG-1','cc1',true)", [centre, r.company]);
  salaryRow = (await r.employee(20000)).salaryRow;
});
afterAll(async () => { await r.teardown(); });

/** Tags `account`'s credit line on the journal with the centre, through the tag tool's own plan + apply. */
async function tagCredit(journal: string, account: string): Promise<void> {
  const line = (await r.pool.query<{ id: string }>(
    `SELECT l.id::text AS id FROM gl_journal_lines l JOIN gl_accounts a ON a.id = l.gl_account_id
      WHERE l.journal_entry_id = $1 AND a.account_code = $2 AND l.credit > 0`, [journal, account])).rows;
  expect(line).toHaveLength(1);
  await withAlsTransaction({ companyId: r.company, userId: r.admin }, async () => {
    const plan = await planDimensionTags(r.company, [{ journalLineId: line[0]!.id, cc1: centre }]);
    await applyDimensionTags(r.company, plan, { idempotencyKey: `retag-${journal}-${account}`, userId: r.admin });
  });
  expect((await r.pool.query('SELECT cc1_id::text AS c FROM gl_journal_lines WHERE id = $1', [line[0]!.id])).rows[0]!.c).toBe(centre);
}

describe('a credit line retagged after posting', () => {
  it('an unchanged, not recalculated run re-locks onto its journal', async () => {
    const id = await r.calculatedRun(2);
    const journal = String((await r.api.approve(id)).body.data!.journalEntryId);
    await tagCredit(journal, '2140');
    expect((await r.api.reopen(id)).statusCode).toBe(200);

    const p = await r.api.preview(id);
    expect(p.body.data!.blocker).toBeNull();
    const again = await r.api.approve(id);
    expect(again.statusCode).toBe(200);
    expect(again.body.data).toMatchObject({ journalEntryId: journal });
  });

  it('a changed figure is still refused, tagged or not', async () => {
    const id = await r.calculatedRun(3);
    const journal = String((await r.api.approve(id)).body.data!.journalEntryId);
    await tagCredit(journal, '2140');
    expect((await r.api.reopen(id)).statusCode).toBe(200);
    // A real change to the figures (the salary, then a recalculation) is still a difference.
    await r.setSalary(salaryRow, 21000);
    expect((await r.api.calculate(id)).statusCode).toBe(200);
    expect((await r.api.preview(id)).body.data!.blocker).toMatchObject({ code: 'recalculated_after_posting' });
    await r.setSalary(salaryRow, 20000);
  });

  it('SYNTHETIC STATE (not reachable in production): header totals edited by direct SQL with no recalculation are still refused (compared as one total, not per cost centre)', async () => {
    const id = await r.calculatedRun(4);
    const journal = String((await r.api.approve(id)).body.data!.journalEntryId);
    await tagCredit(journal, '2140');
    expect((await r.api.reopen(id)).statusCode).toBe(200);
    // SYNTHETIC: production code cannot change a run's header totals without recalculating its lines (calculate
    // restamps them), so this state is built by direct SQL purely to pin the comparison's behaviour for a run NOT
    // recalculated since posting: the lines keep their stamps and only the header figures the plan is built from
    // move (PAYE up, net pay down by the same cents: still balanced). It proves the gate, not a reachable path.
    await r.pool.query('UPDATE payroll_run_headers SET total_paye = total_paye + 100, total_net = total_net - 100 WHERE id = $1', [id]);
    expect((await r.api.preview(id)).body.data!.blocker).toMatchObject({ code: 'recalculated_after_posting' });
    const refused = await r.api.approve(id);
    expect(refused.statusCode).not.toBe(200);
    expect(await r.pool.query('SELECT 1 FROM gl_journal_entries WHERE company_id = $1 AND source = $2 AND description LIKE $3', [r.company, 'auto_payroll', '%2026-04%']))
      .toMatchObject({ rowCount: 1 });
  });
});
