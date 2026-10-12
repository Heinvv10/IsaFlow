/**
 * No NEW journal line writes the legacy cost_center_id (D4, 2026-10-12): a cost-centre pick lives in cc1_id /
 * cc2_id, and the four historic production lines that still carry the legacy id keep it but never spread it.
 *
 *  - createJournalEntry refuses a line that still carries a bare `costCenterId` (it never went through
 *    placeCostCentres), before anything is written; the REST route places the pick itself, so it still posts;
 *  - bank allocation with a CC1 stamps cc1_id on the contra and leaves cost_center_id NULL;
 *  - the reversal of, and a reclassification of, a HISTORIC line (cost_center_id AND cc1_id set) copy cc1_id but
 *    not the legacy id, while the original keeps its own;
 *  - after all of that the company holds exactly the historic lines' worth of non-NULL cost_center_id;
 *  - the delete guard still counts a centre used only through cc1_id, or only through cc2_id.
 * Disposable databases only — the suite skips elsewhere.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { isRefusal, planReclassification } from '@/modules/accounting/services/gl/reclassification/plan';
import { postReclassBatch } from '@/modules/accounting/services/gl/reclassification/post';
import { CostCentrePickRefusal } from '@/modules/accounting/services/gl/dimensions/costCentrePick';
import { CANNOT_DELETE_PREFIX } from '@/modules/accounting/services/core/costCentreUsageGuard';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { inTx, seedBankTx } from './helpers/l1FifoFixture';
import { countRows, type LateFixture } from './helpers/vatLateClaimFixture';
import { callRoute, dataOf } from './helpers/vatLateClaimRoutes';
import { dropPickFixture, legsOn, seedHistoricEntry, seedPickFixture, type PickFixture } from './helpers/costCentrePickFixture';
import journalEntries from '../../pages/api/accounting/journal-entries';
import costCentresAction from '../../pages/api/accounting/cost-centres-action';

const describeIfDb = isDisposableDb() && process.env.JWT_SECRET ? describe : describe.skip;
type Row = Record<string, unknown>;
const DATE = '2026-07-10';
let p: PickFixture;
let fx: LateFixture;
let historicLines = 0;
let reclassSource = '';
let reclassTarget = '';

const historicEntry = async (account: string, amount: number, centre: string) => {
  historicLines++;
  return seedHistoricEntry(p, DATE, account, amount, centre);
};

const centreAccount = async (code: string): Promise<string> => String(((await sql`
  INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active, level)
  VALUES (${fx.companyId}::UUID, ${code}, ${`CCL ${code} ${fx.tag}`}, 'expense', 'default_expense', 'debit', true, 3)
  RETURNING id`) as Row[])[0]!.id);

const del = (id: string) => callRoute(fx, p.token, costCentresAction, { action: 'delete', id });

describeIfDb('the legacy cost_center_id is never written by a new journal line', () => {
  beforeAll(async () => {
    p = await seedPickFixture('CCL', process.env.DATABASE_URL!);
    fx = p.fx;
    reclassSource = await centreAccount('6100');
    reclassTarget = await centreAccount('6200');
  }, 120000);
  afterAll(async () => {
    if (p) {
      await sql`DELETE FROM reclassification_batch_lines WHERE company_id = ${fx.companyId}::UUID`;
      await sql`DELETE FROM reclassification_batches WHERE company_id = ${fx.companyId}::UUID`;
      await sql`UPDATE bank_transactions SET cc1_id = NULL, cc2_id = NULL WHERE company_id = ${fx.companyId}::UUID`;
    }
    await dropPickFixture(p);
  }, 120000);

  it('createJournalEntry refuses a bare costCenterId on a line, writes nothing; the route places the pick and posts', async () => {
    const before = await countRows(fx);
    const lines = [
      { glAccountId: fx.expenseId, debit: 60, credit: 0 },
      { glAccountId: fx.expenseId, debit: 40, credit: 0, costCenterId: p.FT },
      { glAccountId: fx.apId, debit: 0, credit: 100 },
    ];
    const err = await inTx(fx, () => createJournalEntry(fx.companyId, { entryDate: DATE, description: 'CCL bare', lines }, fx.userId))
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(CostCentrePickRefusal);
    expect((err as CostCentrePickRefusal).lineIndex).toBe(1);
    expect((err as Error).message).toContain('Line 2: its cost centre was never placed in a CC1 or CC2 slot');
    expect(await countRows(fx)).toEqual(before);

    const ok = await callRoute(fx, p.token, journalEntries, {
      entryDate: DATE, description: 'CCL route', lines: [
        { glAccountId: fx.expenseId, debit: 60, credit: 0, costCenterId: p.FT },
        { glAccountId: fx.expenseId, debit: 40, credit: 0, costCenterId: p.PH },
        { glAccountId: fx.apId, debit: 0, credit: 100 },
      ],
    });
    expect(ok.statusCode, JSON.stringify(ok.body)).toBe(200);
    expect(await legsOn(p, dataOf<{ id: string }>(ok).id, fx.expenseId)).toEqual([
      { cc1: p.HT, cc2: p.PH, legacy: null, net: 40 }, { cc1: p.FT, cc2: null, legacy: null, net: 60 },
    ]);
  });

  it('bank allocation with a CC1: the contra has cc1_id and no cost_center_id', async () => {
    const tx = await seedBankTx(fx, { date: DATE, amount: -115, description: 'CCL ALLOC' });
    const out = await inTx(fx, () => allocateTransaction(
      fx.companyId, tx, fx.expenseId, fx.userId, undefined, 'account', undefined, undefined, p.FT,
    ));
    expect(await legsOn(p, out.journalEntryId, fx.expenseId)).toEqual([{ cc1: p.FT, cc2: null, legacy: null, net: 115 }]);
    expect(await legsOn(p, out.journalEntryId, fx.bankAccountId)).toEqual([{ cc1: null, cc2: null, legacy: null, net: -115 }]);
  });

  it('reversal of a historic line: the contra copies cc1_id, not cost_center_id; the original keeps its own', async () => {
    const { entryId } = await historicEntry(fx.expenseId, 250, p.FT);
    expect(await legsOn(p, entryId, fx.expenseId)).toEqual([{ cc1: p.FT, cc2: null, legacy: p.FT, net: 250 }]);
    const contra = await inTx(fx, () => reverseJournalEntry(fx.companyId, entryId, fx.userId));
    expect(await legsOn(p, contra.id, fx.expenseId)).toEqual([{ cc1: p.FT, cc2: null, legacy: null, net: -250 }]);
    expect(await legsOn(p, entryId, fx.expenseId)).toEqual([{ cc1: p.FT, cc2: null, legacy: p.FT, net: 250 }]);
  });

  it('reclassification of a historic line: both new legs carry cc1_id and no cost_center_id; the source line is untouched', async () => {
    const { entryId, lineId } = await historicEntry(reclassSource, 400, p.HT);
    const out = await inTx(fx, async () => {
      const plan = await planReclassification({
        companyId: fx.companyId, sourceAccountId: reclassSource, targetAccountId: reclassTarget,
        from: DATE, to: DATE, postingDate: null, lockCandidateLines: true,
      });
      if (isRefusal(plan)) throw new Error(`unexpected refusal: ${plan.refused}`);
      expect(plan.movable.map((m) => m.lineId)).toEqual([lineId]);
      return postReclassBatch(fx.companyId, fx.userId, {
        tool: 'post_reclassification_batch', sourceAccountId: reclassSource, targetAccountId: reclassTarget,
        postingDate: null, idempotencyKey: null, drafts: plan.drafts,
      });
    });
    const journalId = out.journals[0]!.journalEntryId;
    expect(out.journals).toHaveLength(1);
    expect(await legsOn(p, journalId, reclassSource)).toEqual([{ cc1: p.HT, cc2: null, legacy: null, net: -400 }]);
    expect(await legsOn(p, journalId, reclassTarget)).toEqual([{ cc1: p.HT, cc2: null, legacy: null, net: 400 }]);
    expect(await legsOn(p, entryId, reclassSource)).toEqual([{ cc1: p.HT, cc2: null, legacy: p.HT, net: 400 }]);
  });

  it('no new line got cost_center_id: the company holds exactly the historic lines\' worth', async () => {
    expect(historicLines).toBe(2);
    const [r] = (await sql`
      SELECT COUNT(*)::INT AS n FROM gl_journal_lines
      WHERE company_id = ${fx.companyId}::UUID AND cost_center_id IS NOT NULL`) as Row[];
    expect(r!.n).toBe(historicLines);
  });

  it('the delete guard counts a centre used only through cc1_id, or only through cc2_id; an unused one deletes', async () => {
    const [cc1, fno, cc2, spare] = await Promise.all(['DEL1', 'DEL2F', 'DEL2', 'DEL3'].map(async (code, i) => String(((await sql`
      INSERT INTO cost_centres (company_id, code, name, cc_type, is_active)
      VALUES (${fx.companyId}::UUID, ${code}, ${`CCL ${code}`}, ${i === 2 ? 'cc2' : 'cc1'}, true) RETURNING id`) as Row[])[0]!.id)));
    await sql`UPDATE cost_centres SET parent_id = ${fno}::UUID WHERE id = ${cc2}::UUID`;
    await inTx(fx, () => createJournalEntry(fx.companyId, {
      entryDate: DATE, description: 'CCL guard', lines: [
        { glAccountId: fx.expenseId, debit: 10, credit: 0, cc1Id: cc1 },
        { glAccountId: fx.expenseId, debit: 20, credit: 0, cc2Id: cc2 },
        { glAccountId: fx.apId, debit: 0, credit: 30 },
      ],
    }, fx.userId));
    const [legacy] = (await sql`
      SELECT COUNT(*)::INT AS n FROM gl_journal_lines
      WHERE company_id = ${fx.companyId}::UUID AND cost_center_id = ANY(${[cc1, cc2, fno]}::UUID[])`) as Row[];
    expect(legacy!.n).toBe(0);

    for (const id of [cc1, cc2]) {
      const refused = await del(id);
      expect(refused.statusCode, JSON.stringify(refused.body)).toBe(400);
      expect(JSON.stringify(refused.body)).toContain(`${CANNOT_DELETE_PREFIX}1 journal line(s)`);
      expect(((await sql`SELECT COUNT(*)::INT AS n FROM cost_centres WHERE id = ${id}::UUID`) as Row[])[0]!.n).toBe(1);
    }
    const gone = await del(spare);
    expect(gone.statusCode, JSON.stringify(gone.body)).toBe(200);
  });
});
