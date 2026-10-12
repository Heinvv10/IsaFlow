/**
 * The import auto-post sweep reports a cost-centre pick it could not apply
 * (PR #688 follow-up F3). `postProvisional` drops a predicted centre that has
 * since been withdrawn and returns the sentence as `warnings`; the sweep used
 * to read it and throw it away, so a sweep over an import silently lost the
 * pick. `SweepResult.warnings` now carries it, per bank transaction, beside
 * the journal that was posted without the centre.
 *
 *  - two lines predicted to an INACTIVE centre: both post, both are reported,
 *    each under its own bank transaction and journal;
 *  - the same sweep with an active centre reports nothing, and the centre lands;
 *  - what is posted is unchanged: the lines are bare of the dropped centre.
 * Disposable databases only — the suite skips elsewhere.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { sweep } from '@/modules/accounting/services/bank/autoPostGateService';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { inTx, seedBankTx } from './helpers/l1FifoFixture';
import type { LateFixture } from './helpers/vatLateClaimFixture';
import { bareOn, dropPickFixture, legsOn, seedPickFixture, type PickFixture } from './helpers/costCentrePickFixture';

const describeIfDb = isDisposableDb() ? describe : describe.skip;
type Row = Record<string, unknown>;
const DATE = '2026-07-10';
const INACTIVE_WARNING = 'Line 1: cost centre OLD is inactive and was not applied — the line posts without it.';
let p: PickFixture;
let fx: LateFixture;

const provisionalJournal = async (txId: string): Promise<string> => String(((await sql`
  SELECT provisional_je_id FROM bank_transactions
  WHERE id = ${txId}::UUID AND company_id = ${fx.companyId}::UUID`) as Row[])[0]!.provisional_je_id);

describeIfDb('the import auto-post sweep reports the cost-centre picks it could not apply', () => {
  beforeAll(async () => {
    p = await seedPickFixture('F3W', process.env.DATABASE_URL!);
    fx = p.fx;
    await sql`
      INSERT INTO bank_auto_post_settings
        (company_id, enabled, min_confidence, amount_cap, llm_enabled, llm_min_confidence, llm_amount_cap, updated_at)
      VALUES (${fx.companyId}::UUID, true, 0.50, 0, false, 0.95, 2000, NOW())`;
    // Three postings of the supplier to the expense account under one centre: the predictor's history.
    for (let i = 0; i < 3; i++) {
      await sql`
        INSERT INTO supplier_coding_history (company_id, supplier_id, gl_account_id, vat_code, cost_centre_id, posted_by)
        VALUES (${fx.companyId}::UUID, ${fx.supplierId}::UUID, ${fx.expenseId}::UUID, 'standard', ${p.INACTIVE}::UUID, ${fx.userId})`;
    }
  }, 120000);

  afterAll(async () => {
    if (!p) return;
    const c = fx.companyId;
    await sql`DELETE FROM bank_transactions WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM bank_auto_post_runs WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM bank_auto_post_settings WHERE company_id = ${c}::UUID`;
    await dropPickFixture(p);
  }, 120000);

  const run = (ids: string[]) => inTx(fx, () => sweep(fx.companyId, ids, 'import', fx.userId, fx.userId));

  it('returns each dropped pick under its bank transaction and journal, and posts the lines without it', async () => {
    // seedBankTx appends the fixture tag, which is also the fixture supplier's name: that is the match.
    const a = await seedBankTx(fx, { date: DATE, amount: -115, description: 'WALTONS STATIONERY' });
    const b = await seedBankTx(fx, { date: DATE, amount: -230, description: 'WALTONS PAPER' });
    const out = await run([a, b]);
    expect(out.posted, JSON.stringify(out)).toBe(2);
    const [jeA, jeB] = [await provisionalJournal(a), await provisionalJournal(b)];
    expect([...out.warnings].sort((x, y) => x.txId.localeCompare(y.txId))).toEqual([
      { txId: a, journalEntryId: jeA, warnings: [INACTIVE_WARNING] },
      { txId: b, journalEntryId: jeB, warnings: [INACTIVE_WARNING] },
    ].sort((x, y) => x.txId.localeCompare(y.txId)));
    // Reporting only: what is posted is the same as ever — the expense line, bare of the withdrawn centre.
    expect(await legsOn(p, jeA, fx.expenseId)).toEqual([{ cc1: null, cc2: null, legacy: null, net: 100 }]);
    expect(await bareOn(p, jeB, fx.expenseId)).toBe(true);
  });

  it('reports nothing when the centre is active, and the centre lands on the line', async () => {
    await sql`UPDATE supplier_coding_history SET cost_centre_id = ${p.FT}::UUID WHERE company_id = ${fx.companyId}::UUID`;
    const c = await seedBankTx(fx, { date: DATE, amount: -345, description: 'WALTONS TONER' });
    const out = await run([c]);
    expect(out.posted, JSON.stringify(out)).toBe(1);
    expect(out.warnings).toEqual([]);
    expect(await legsOn(p, await provisionalJournal(c), fx.expenseId)).toEqual([{ cc1: p.FT, cc2: null, legacy: null, net: 300 }]);
  });
});
