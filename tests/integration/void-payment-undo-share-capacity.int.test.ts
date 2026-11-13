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

  it('a hand undo crediting the clearing account in two lines is summed, not matched line by line', async () => {
    const fuel = [{ account: a.expense2, debit: 130.43 }, { account: a.vatInput, debit: 19.57, vatType: 'standard' }];
    const b = await billWithJournal(fx, a, 'TWOLINE', '2026-05-10', fuel);
    const p = await contra(b.id, 150);
    // The clearing account is the tight side (225); the accounts have room for two bills.
    const share = await postedJournal(fx, '2026-05-31', [{ account: a.clearing, debit: 225 }, { account: a.bank, debit: 75 },
      { account: a.expense2, credit: 260.86 }, { account: a.vatInput, credit: 39.14, vatType: 'standard' }]);
    await postedJournal(fx, '2026-05-31', [...fuel, { account: a.clearing, credit: 75 }, { account: a.clearing, credit: 75 }], 'hand undo, two lines');
    expect(text(await undo(p, share, { undo_amounts: [{ bill_id: b.id, amount: 150 }] })))
      .toMatch(/does not hold the R\s?150\.00 being undone on 1560731/);
  }, 120000);

  it('another share\'s linked undo, or the reversal of another share, is not a hand undo of this one', async () => {
    const shareOf = () => postedJournal(fx, '2026-05-31', [{ account: a.clearing, debit: 1150 }, { account: a.expense, credit: 1000 },
      { account: a.vatInput, credit: 150, vatType: 'standard' }]);
    const [b1, b2, b3] = [await billWithJournal(fx, a, 'OTHER1', '2026-05-10', legs()),
      await billWithJournal(fx, a, 'OTHER2', '2026-05-11', legs()), await billWithJournal(fx, a, 'OTHER3', '2026-05-12', legs())];
    const [p1, p2] = [await contra(b1.id, 1150), await contra(b2.id, 1150)];
    await contra(b3.id, 1150);
    const [s1, s2, s3] = [await shareOf(), await shareOf(), await shareOf()];
    // An undo linked to s1, created after s2 and s3, on the same accounts: not s2's.
    expect((await undo(p1, s1)).isError).toBeFalsy();
    // s3 reversed (no undos of it): its reversal debits the accounts and credits the clearing account — not s2's either.
    await inTx(fx, () => reverseJournalEntry(fx.companyId, s3, fx.userId));
    const r = await undo(p2, s2);
    expect(r.isError, text(r)).toBeFalsy();
  }, 120000);

  it('Velocity-shaped: monthly shares on the same accounts — a June hand undo does not refuse a May undo', async () => {
    const may = await billWithJournal(fx, a, 'VMAY', '2026-05-10', legs());
    const jun = await billWithJournal(fx, a, 'VJUN', '2026-06-10', legs());
    const pMay = await contra(may.id, 1150);
    await contra(jun.id, 1150);
    const shareLegs = [{ account: a.clearing, debit: 1150 }, { account: a.expense, credit: 1000 },
      { account: a.vatInput, credit: 150, vatType: 'standard' }];
    const sMay = await postedJournal(fx, '2026-05-31', shareLegs);
    await postedJournal(fx, '2026-06-30', shareLegs);
    // JE-2026-31951 style: the June bill's share undone by hand, dated in June.
    await postedJournal(fx, '2026-06-30', [...legs(), { account: a.clearing, credit: 1150 }], 'hand undo VJUN');
    const r = await undo(pMay, sMay);
    expect(r.isError, text(r)).toBeFalsy();
  }, 120000);

  it('a hand undo made before a share was re-dated (reverse-and-repost) counts against the re-posted share', async () => {
    const b = await billWithJournal(fx, a, 'REDATE', '2026-07-10', legs());
    const p = await contra(b.id, 1150);
    const shareLegs = [{ account: a.clearing, debit: 1150 }, { account: a.expense, credit: 1000 },
      { account: a.vatInput, credit: 150, vatType: 'standard' }];
    const old = await postedJournal(fx, '2026-07-31', shareLegs);
    await postedJournal(fx, '2026-07-31', [...legs(), { account: a.clearing, credit: 1150 }], 'hand undo REDATE');
    await inTx(fx, () => reverseJournalEntry(fx.companyId, old, fx.userId));
    const reposted = await postedJournal(fx, '2026-07-31', shareLegs);
    expect(text(await undo(p, reposted))).toMatch(/does not hold .*including hand journal JE-/);
  }, 120000);

  it('a hand undo reversed once counts nothing (its chain nets to nil)', async () => {
    const b = await billWithJournal(fx, a, 'HANDREV', '2026-08-10', legs());
    const p = await contra(b.id, 1150);
    const share = await postedJournal(fx, '2026-08-31', [{ account: a.clearing, debit: 1150 }, { account: a.expense, credit: 1000 },
      { account: a.vatInput, credit: 150, vatType: 'standard' }]);
    const hand = await postedJournal(fx, '2026-08-31', [...legs(), { account: a.clearing, credit: 1150 }], 'hand undo, later reversed');
    await inTx(fx, () => reverseJournalEntry(fx.companyId, hand, fx.userId));
    const r = await undo(p, share);
    expect(r.isError, text(r)).toBeFalsy();
  }, 120000);

  it('the refusal names at most ten hand journals, then "and N more"', async () => {
    const b = await billWithJournal(fx, a, 'MANYHAND', '2026-09-10', [{ account: a.expense, debit: 150 }]);
    const p = await contra(b.id, 150);
    const share = await postedJournal(fx, '2026-09-30', [{ account: a.clearing, debit: 1200 }, { account: a.expense, credit: 1200 }]);
    for (let i = 0; i < 11; i++) {
      await postedJournal(fx, '2026-09-30', [{ account: a.expense, debit: 100 }, { account: a.clearing, credit: 100 }], `hand ${i}`);
    }
    const msg = text(await undo(p, share, { undo_amounts: [{ bill_id: b.id, amount: 150 }] }));
    expect(msg).toMatch(/including hand journals (JE-\d{4}-\d+, ){9}JE-\d{4}-\d+ and 1 more\)/);
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
