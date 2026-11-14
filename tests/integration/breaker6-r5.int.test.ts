import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { McpRegistry } from '@/lib/mcp/registry';
import { voidPaymentTool } from '@/lib/mcp/tools/writeVoidPayments';
import { settleByContraTool } from '@/lib/mcp/tools/writeSettleByContra';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { getVATReturn } from '@/modules/accounting/services/reports/vatReturnService';
import type { McpToolContext } from '@/lib/mcp/types';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, inTx, seedFixture, type Fixture } from './helpers/l1FifoFixture';
import { apSubledger, billWithJournal, dropStepExtras, ledger, postedJournal, seedStepAccounts, type StepAccounts } from './helpers/shareUndoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
type Row = Record<string, unknown>;
let fx: Fixture;
let a: StepAccounts;
const registry = new McpRegistry();
registry.register(voidPaymentTool);
const ctx = (): McpToolContext => ({ userId: fx.userId, companyId: fx.companyId, scopes: ['write:invoices', 'write:post', 'write:journals'],
  companyRole: 'owner', tokenJti: 'brk6', oauthAppId: null } as McpToolContext);
const call = (args: Row) => inTx(fx, () => registry.call('void_payment', args, ctx()));
const text = (r: { content: { text: string }[] }) => r.content[0]!.text;
const contra = async (billId: string, amount: number) => {
  const r = await inTx(fx, () => settleByContraTool.handler({ subledger: 'ap', document_id: billId, contra_account_id: a.clearing, amount,
    reason: 'petty cash', settlement_date: '2026-09-17', idempotency_key: crypto.randomUUID() }, ctx()));
  expect(r.isError, text(r)).toBeFalsy();
  return String(JSON.parse(text(r)).payment_id);
};
const vatMay = async () => (await getVATReturn(fx.companyId, '2026-05-01', '2026-05-31')).totalInputTax;
const legs = () => [{ account: a.expense, debit: 1000 }, { account: a.vatInput, debit: 150, vatType: 'standard' }];
const r2 = (n: number) => Math.round(n * 100) / 100;


const fuel = () => [{ account: a.expense2, debit: 130.43 }, { account: a.vatInput, debit: 19.57, vatType: 'standard' }];
const shareOf = (n: number, ref: string) => postedJournal(fx, '2026-05-31', [{ account: a.clearing, debit: r2(150 * n) },
  { account: a.expense2, credit: r2(130.43 * n) }, { account: a.vatInput, credit: r2(19.57 * n), vatType: 'standard' }], ref);
const handUndo = (ref: string) => postedJournal(fx, '2026-05-31', [{ account: a.expense2, debit: 130.43 },
  { account: a.vatInput, debit: 19.57, vatType: 'standard' }, { account: a.clearing, credit: 150 }], ref);


const shareOn = (date: string, ref: string) => postedJournal(fx, date, [{ account: a.clearing, debit: 150 },
  { account: a.expense2, credit: 130.43 }, { account: a.vatInput, credit: 19.57, vatType: 'standard' }], ref);
const handOn = (date: string, ref: string) => postedJournal(fx, date, [{ account: a.expense2, debit: 130.43 },
  { account: a.vatInput, debit: 19.57, vatType: 'standard' }, { account: a.clearing, credit: 150 }], ref);
const vatJun = async () => (await getVATReturn(fx.companyId, '2026-06-01', '2026-06-30')).totalInputTax;
const rev = (id: string) => inTx(fx, () => reverseJournalEntry(fx.companyId, id, fx.userId));
const undo = (p: string, s: string) => call({ payment_id: p, undo_share: true, share_journal_id: s, idempotency_key: crypto.randomUUID() });


const vatAprMay = async () => (await getVATReturn(fx.companyId, '2026-04-01', '2026-05-31')).totalInputTax;


describe.skipIf(!DATABASE_URL)('breaker6 round 5', () => {
  beforeAll(async () => {
    assertNotProductionDb('breaker6 r5 posts journals.');
    fx = await seedFixture('BRK6R5', DATABASE_URL!); a = await seedStepAccounts(fx);
  }, 120000);
  afterAll(async () => { await dropStepExtras(fx); await dropFixture(fx); }, 120000);
  const vatM = async (m: string) => (await getVATReturn(fx.companyId, `2026-${m}-01`, `2026-${m}-${m === '06' || m === '09' ? '30' : '31'}`)).totalInputTax;

  it('REPRO 18: hand undo of A inside a net-zero month-end correction journal (remove A, add C) is not seen', async () => {
    const v0 = await vatM('05');
    const A = await billWithJournal(fx, a, 'R18A', '2026-05-10', fuel());
    const C = await billWithJournal(fx, a, 'R18C', '2026-05-12', fuel());
    const pA = await contra(A.id, 150); await contra(C.id, 150);
    const s = await shareOn('2026-05-31', 'SHARE-18 (A)');
    // Correction: A should not have been shared, C should have been. One journal, X nets to zero.
    await postedJournal(fx, '2026-05-31', [
      { account: a.expense2, debit: 130.43 }, { account: a.vatInput, debit: 19.57, vatType: 'standard' }, { account: a.clearing, credit: 150 },
      { account: a.clearing, debit: 150 }, { account: a.expense2, credit: 130.43 }, { account: a.vatInput, credit: 19.57, vatType: 'standard' }],
      'share correction: out A, in C');
    const r = await undo(pA, s);
    // Bills 39.14, share(A) -19.57, correction 0 (A back, C out) => 19.57. A must not be restored again.
    expect({ refused: r.isError === true, vatDelta: r2(await vatM('05') - v0) }).toEqual({ refused: true, vatDelta: 19.57 });
  }, 120000);

  it('REPRO 19: the hand undo a person posts when told to ("post that undo by hand") using the tool\'s own reference format is not counted', async () => {
    const v0 = await vatM('06');
    const A = await billWithJournal(fx, a, 'R19A', '2026-06-10', fuel());
    const p1 = await contra(A.id, 150);
    const s = await shareOn('2026-06-30', 'SHARE-19');
    // p1 voided plainly, share undone by hand with the reference undo_share would have written.
    const pv = await call({ payment_id: p1, idempotency_key: crypto.randomUUID() });
    expect(pv.isError, text(pv)).toBeFalsy();
    await postedJournal(fx, '2026-06-30', [{ account: a.expense2, debit: 130.43 }, { account: a.vatInput, debit: 19.57, vatType: 'standard' },
      { account: a.clearing, credit: 150 }], `undo-share:${p1}:${A.id}`);
    const p2 = await contra(A.id, 150);
    const r = await undo(p2, s);
    expect({ refused: r.isError === true, vatDelta: r2(await vatM('06') - v0) }).toEqual({ refused: true, vatDelta: 19.57 });
  }, 120000);

  it('REPRO 20: share re-posted WITHOUT bill A (Velocity reverse-and-repost); undo of A against the new share passes', async () => {
    const v0 = await vatM('09');
    const A = await billWithJournal(fx, a, 'R20A', '2026-09-10', fuel());
    const B = await billWithJournal(fx, a, 'R20B', '2026-09-11', fuel());
    const pA = await contra(A.id, 150); await contra(B.id, 150);
    const s = await postedJournal(fx, '2026-09-30', [{ account: a.clearing, debit: 300 }, { account: a.expense2, credit: 260.86 },
      { account: a.vatInput, credit: 39.14, vatType: 'standard' }], 'SHARE-20 A+B');
    await rev(s);
    const s2 = await shareOn('2026-09-30', 'SHARE-20 B only (A taken out)');
    const r = await undo(pA, s2);
    // Bills 39.14, share B -19.57 => 19.57. A was never in s2.
    expect({ refused: r.isError === true, vatDelta: r2(await vatM('09') - v0) }).toEqual({ refused: true, vatDelta: 19.57 });
  }, 120000);
});
