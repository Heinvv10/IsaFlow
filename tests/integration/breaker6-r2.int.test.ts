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

describe.skipIf(!DATABASE_URL)('breaker6 round 2', () => {
  beforeAll(async () => {
    assertNotProductionDb('breaker6 r2 posts journals.');
    fx = await seedFixture('BRK6R2', DATABASE_URL!); a = await seedStepAccounts(fx);
  }, 120000);
  afterAll(async () => { await dropStepExtras(fx); await dropFixture(fx); }, 120000);

  it('REPRO 8: two R150 fuel bills on one share; b1 undone by hand -> b2 falsely refused; ack then lets b1 be undone twice', async () => {
    const vat0 = await vatMay();
    const b1 = await billWithJournal(fx, a, 'FUEL1', '2026-05-10', fuel());
    const b2 = await billWithJournal(fx, a, 'FUEL2', '2026-05-11', fuel());
    const p1 = await contra(b1.id, 150); const p2 = await contra(b2.id, 150);
    const share = await shareOf(2, 'SHARE-FUEL');
    await handUndo('hand undo FUEL1');   // a person undid b1's share (b1's contra voided by hand later is not needed)
    const v2 = await call({ payment_id: p2, undo_share: true, share_journal_id: share, undo_amounts: [{ bill_id: b2.id, amount: 150 }],
      idempotency_key: crypto.randomUUID() });
    const b2FalselyRefused = v2.isError === true;
    if (b2FalselyRefused) {
      const ack = await call({ payment_id: p2, undo_share: true, share_journal_id: share, undo_amounts: [{ bill_id: b2.id, amount: 150 }],
        acknowledge_manual_undo: true, idempotency_key: crypto.randomUUID() });
      expect(ack.isError, text(ack)).toBeFalsy();
    }
    // The agent, having learned to acknowledge, voids b1's contra with undo too.
    const v1 = await call({ payment_id: p1, undo_share: true, share_journal_id: share, undo_amounts: [{ bill_id: b1.id, amount: 150 }],
      acknowledge_manual_undo: true, idempotency_key: crypto.randomUUID() });
    const vatDelta = r2(await vatMay() - vat0);
    // Correct: bills +39.14, share -39.14, hand undo b1 +19.57, undo b2 +19.57 = 39.14; b1 must not be undone a 2nd time.
    expect({ b2FalselyRefused, b1SecondUndoRefused: v1.isError === true, vatDelta })
      .toEqual({ b2FalselyRefused: false, b1SecondUndoRefused: true, vatDelta: 39.14 });
  }, 120000);

  it('REPRO 9: hand undo crediting the clearing account in two lines (expense + VAT) dodges detection', async () => {
    const vat0 = await vatMay();
    const b = await billWithJournal(fx, a, 'FUEL9', '2026-05-10', fuel());
    const p = await contra(b.id, 150);
    const share = await shareOf(1, 'SHARE-9');
    await postedJournal(fx, '2026-05-31', [{ account: a.expense2, debit: 130.43 }, { account: a.clearing, credit: 130.43 },
      { account: a.vatInput, debit: 19.57, vatType: 'standard' }, { account: a.clearing, credit: 19.57 }], 'hand undo FUEL9');
    const r = await call({ payment_id: p, undo_share: true, share_journal_id: share, idempotency_key: crypto.randomUUID() });
    expect({ refused: r.isError === true, vatDelta: r2(await vatMay() - vat0) }).toEqual({ refused: true, vatDelta: 19.57 });
  }, 120000);

  it('REPRO 10: reversing the share after an undo restores the bill a second time (nothing refuses it)', async () => {
    const vat0 = await vatMay();
    const b = await billWithJournal(fx, a, 'FUEL10', '2026-05-10', fuel());
    const p = await contra(b.id, 150);
    const share = await shareOf(1, 'SHARE-10');
    const u = await call({ payment_id: p, undo_share: true, share_journal_id: share, idempotency_key: crypto.randomUUID() });
    expect(u.isError, text(u)).toBeFalsy();
    let reversed = true;
    try { await inTx(fx, () => reverseJournalEntry(fx.companyId, share, fx.userId)); } catch { reversed = false; }
    expect({ reversed, vatDelta: r2(await vatMay() - vat0) }).toEqual({ reversed: false, vatDelta: 19.57 });
  }, 120000);

  it('CHECK 11: reversed undo frees capacity; re-undo after a new contra nets correctly', async () => {
    const vat0 = await vatMay();
    const b = await billWithJournal(fx, a, 'FUEL11', '2026-05-10', fuel());
    const p = await contra(b.id, 150);
    const share = await shareOf(1, 'SHARE-11');
    const u = JSON.parse(text(await call({ payment_id: p, undo_share: true, share_journal_id: share, idempotency_key: crypto.randomUUID() })));
    await inTx(fx, () => reverseJournalEntry(fx.companyId, u.undo_share.journal_entry_ids[0], fx.userId));
    const p2 = await contra(b.id, 150);
    const u2 = await call({ payment_id: p2, undo_share: true, share_journal_id: share, idempotency_key: crypto.randomUUID() });
    expect(u2.isError, text(u2)).toBeFalsy();
    const l = await ledger(fx);
    expect({ vatDelta: r2(await vatMay() - vat0), balanced: l.balanced }).toEqual({ vatDelta: 19.57, balanced: true });
  }, 120000);
});
