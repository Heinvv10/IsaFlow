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



describe.skipIf(!DATABASE_URL)('breaker6 round 6', () => {
  beforeAll(async () => {
    assertNotProductionDb('breaker6 r6 posts journals.');
    fx = await seedFixture('BRK6R6', DATABASE_URL!); a = await seedStepAccounts(fx);
  }, 120000);
  afterAll(async () => { await dropStepExtras(fx); await dropFixture(fx); }, 120000);
  const vatAugSep = async () => (await getVATReturn(fx.companyId, '2026-08-01', '2026-09-30')).totalInputTax;

  it('REPRO 21: one multi-month share (dated Sep, covers Aug bills) re-dated per month WITHOUT bill A -> fingerprint outside window', async () => {
    const v0 = await vatAugSep();
    const A = await billWithJournal(fx, a, 'R21A', '2026-08-10', fuel());
    const C = await billWithJournal(fx, a, 'R21C', '2026-08-12', fuel());
    const pA = await contra(A.id, 150); await contra(C.id, 150);
    // JE-2026-16144 shape: one share dated at a later month-end covering earlier months' bills.
    const old = await postedJournal(fx, '2026-09-30', [{ account: a.clearing, debit: 300 }, { account: a.expense2, credit: 260.86 },
      { account: a.vatInput, credit: 39.14, vatType: 'standard' }], 'SHARE Sep (A+C, Aug bills)');
    await rev(old);
    // Re-dated into the bills' month (23852..23856 shape), A left out.
    const aug = await shareOn('2026-08-31', 'SHARE Aug (C only)');
    const r = await undo(pA, aug);
    // Bills 39.14, Aug share (C) -19.57 => 19.57. A was restored by the old share's reversal already.
    expect({ refused: r.isError === true, vatDelta: r2(await vatAugSep() - v0) }).toEqual({ refused: true, vatDelta: 19.57 });
  }, 120000);
});
