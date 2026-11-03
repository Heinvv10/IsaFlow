/**
 * Follow-up B of PR #1065, review: the approve dialog's cost-centre labels
 * (GET …/journal-plan `costCentres`) never name another company's centre.
 * Real rows in two companies:
 *
 *  - the label read itself: asked for this company's centre AND the other
 *    company's, it returns this company's only;
 *  - through the route: a posted journal line carrying the other company's
 *    centre id (a legacy foreign tag — gl_journal_lines.cc1_id's FK is
 *    single-column, journalLineOwnership) is shown on the re-lock preview, but
 *    the label map holds only the run's own centre.
 *
 * Real routes (withAuth, app_user, RLS) on the disposable fixture.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCostCentreLabels } from '@/modules/accounting/services/payroll/payrollJournalPlanLabels';
import { rig } from './brkr.helpers';

let r: Awaited<ReturnType<typeof rig>>;
const other = crypto.randomUUID();
const own = crypto.randomUUID();
const foreign = crypto.randomUUID();
const line = (cc1Id: string | null) => ({ glAccountId: 'g', accountCode: '5200', accountName: 'Labour', debit: 1, credit: 0, cc1Id });

beforeAll(async () => {
  r = await rig('cc1labels'); await r.setup();
  await r.pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [other, 'cc1 labels other']);
  await r.pool.query("INSERT INTO cost_centres (id, company_id, code, name, cc_type, is_active) VALUES ($1,$2,'OWN-1','Own centre','cc1',true)", [own, r.company]);
  await r.pool.query("INSERT INTO cost_centres (id, company_id, code, name, cc_type, is_active) VALUES ($1,$2,'THEIRS','Other company centre','cc1',true)", [foreign, other]);
  const e = (await r.employee(20000)).employee;
  await r.pool.query('UPDATE payroll_employees SET cost_centre_id = $1 WHERE id = $2', [own, e]);
  await r.employee(10000); // untagged labour on 5200 beside the tagged line
});
afterAll(async () => {
  await r.pool.query('DELETE FROM cost_centres WHERE company_id = $1', [other]).catch(() => undefined);
  await r.pool.query('DELETE FROM companies WHERE id = $1', [other]).catch(() => undefined);
  await r.teardown();
});

describe('the approve dialog\'s cost-centre labels are company-scoped', () => {
  it('the label read names this company\'s centre and not the other company\'s', async () => {
    const out = await withCostCentreLabels(r.company, {
      plan: { lines: [line(own), line(foreign), line(null)] }, posted: null, replaces: null, blocker: null, planHash: 'h',
    } as never);
    expect(out.costCentres).toEqual({ [own]: { code: 'OWN-1', name: 'Own centre' } });
  });

  it('a posted line carrying another company\'s centre is never labelled through the route', async () => {
    const id = await r.calculatedRun(3);
    const journal = String((await r.api.approve(id)).body.data!.journalEntryId);
    expect((await r.api.reopen(id)).statusCode).toBe(200);
    // A legacy foreign tag on the untagged 5200 labour line.
    await r.pool.query(`UPDATE gl_journal_lines SET cc1_id = $2 WHERE journal_entry_id = $1 AND debit > 0 AND cc1_id IS NULL`, [journal, foreign]);
    const p = await r.api.preview(id);
    expect(p.statusCode).toBe(200);
    const postedCc1 = (p.body.data!.posted.lines as Array<{ cc1Id: string | null }>).map((l) => l.cc1Id);
    expect(postedCc1).toContain(foreign);
    expect(postedCc1).toContain(own);
    expect(p.body.data!.costCentres).toEqual({ [own]: { code: 'OWN-1', name: 'Own centre' } });
    expect(JSON.stringify(p.body.data!.costCentres)).not.toContain('THEIRS');
  });
});
