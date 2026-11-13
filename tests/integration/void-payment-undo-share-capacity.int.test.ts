/**
 * void_payment(undo_share): a share's capacity is cumulative over its LIVE undos (review round 1, breaker REPRO 1/4).
 * Each side of the check is pinned on its own: the clearing-account side refuses when the share's account credits
 * would still allow it, the per-account side when its clearing debit would, and a reversed undo gives its capacity
 * back.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, inTx, seedFixture, type Fixture } from './helpers/l1FifoFixture';
import { billWithJournal, dropStepExtras, postedJournal, seedStepAccounts, type StepAccounts } from './helpers/shareUndoFixture';
import { text, undoShareKit } from './helpers/undoShareKit';

const DATABASE_URL = process.env.DATABASE_URL;
let fx: Fixture;
let a: StepAccounts;
const { call, contra } = undoShareKit(() => fx, () => a);
const undo = (pay: string, share: string, extra: Record<string, unknown> = {}) =>
  call({ payment_id: pay, undo_share: true, share_journal_id: share, idempotency_key: crypto.randomUUID(), ...extra });
const legs = () => [{ account: a.expense, debit: 1000 }, { account: a.vatInput, debit: 150, vatType: 'standard' }];

describe.skipIf(!DATABASE_URL)('void_payment undo_share — cumulative share capacity', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test posts journals and voids payments.');
    fx = await seedFixture('UNDOC', DATABASE_URL!);
    a = await seedStepAccounts(fx);
  }, 120000);
  afterAll(async () => { await dropStepExtras(fx); await dropFixture(fx); }, 120000);

  it('the clearing-account side: account credits to spare, but the clearing debit is used up', async () => {
    const b1 = await billWithJournal(fx, a, 'XSIDE1', '2026-05-10', legs());
    const b2 = await billWithJournal(fx, a, 'XSIDE2', '2026-05-11', legs());
    const [p1, p2] = [await contra(b1.id, 1150), await contra(b2.id, 1150)];
    // Credits expense 2,000 / VAT 300 (room for both bills) but debits the clearing account only 1,150 (+ bank 1,150).
    const share = await postedJournal(fx, '2026-05-31', [{ account: a.clearing, debit: 1150 }, { account: a.bank, debit: 1150 },
      { account: a.expense, credit: 2000 }, { account: a.vatInput, credit: 300, vatType: 'standard' }]);
    expect((await undo(p1, share)).isError).toBeFalsy();
    expect(text(await undo(p2, share))).toMatch(/does not hold the R\s?1\s?150\.00 being undone on 1560731/);
  }, 120000);

  it('the per-account side: clearing debit to spare, but the expense credit is used up', async () => {
    const b1 = await billWithJournal(fx, a, 'ASIDE1', '2026-05-10', legs());
    const b2 = await billWithJournal(fx, a, 'ASIDE2', '2026-05-11', legs());
    const [p1, p2] = [await contra(b1.id, 1150), await contra(b2.id, 1150)];
    // Debits the clearing account 2,300 but credits expense only 1,000 (the rest went to 6100).
    const share = await postedJournal(fx, '2026-05-31', [{ account: a.clearing, debit: 2300 }, { account: a.expense, credit: 1000 },
      { account: a.expense2, credit: 1000 }, { account: a.vatInput, credit: 300, vatType: 'standard' }]);
    expect((await undo(p1, share, { undo_amounts: [{ bill_id: b1.id, amount: 1150 }] })).isError).toBeFalsy();
    expect(text(await undo(p2, share, { undo_amounts: [{ bill_id: b2.id, amount: 1150 }] })))
      .toMatch(/does not hold the R\s?1\s?000\.00 the bills posted to account 6000/);
  }, 120000);

  it('a reversed undo gives its capacity back: the next contra on the bill can be undone against the same share', async () => {
    const b = await billWithJournal(fx, a, 'REVERSED', '2026-05-10', legs());
    const p1 = await contra(b.id, 1150);
    const share = await postedJournal(fx, '2026-05-31', [{ account: a.clearing, debit: 1150 }, { account: a.expense, credit: 1000 },
      { account: a.vatInput, credit: 150, vatType: 'standard' }]);
    const first = await undo(p1, share);
    expect(first.isError, text(first)).toBeFalsy();
    const [undoId] = JSON.parse(text(first)).undo_share.journal_entry_ids as string[];
    await inTx(fx, () => reverseJournalEntry(fx.companyId, undoId!, fx.userId));
    const p2 = await contra(b.id, 1150);
    const again = await undo(p2, share);
    expect(again.isError, text(again)).toBeFalsy();
  }, 120000);
});
