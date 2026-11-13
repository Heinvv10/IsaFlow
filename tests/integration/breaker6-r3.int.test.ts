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
const vat07 = async () => (await getVATReturn(fx.companyId, '2026-07-01', '2026-07-31')).totalInputTax;
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

describe.skipIf(!DATABASE_URL)('breaker6 round 3', () => {
  beforeAll(async () => {
    assertNotProductionDb('breaker6 r3 posts journals.');
    fx = await seedFixture('BRK6R3', DATABASE_URL!); a = await seedStepAccounts(fx);
  }, 120000);
  afterAll(async () => { await dropStepExtras(fx); await dropFixture(fx); }, 120000);

  it('REPRO 12: a hand undo of a LATER month\'s share blocks the first, legitimate undo of an earlier one-bill share', async () => {
    const bMay = await billWithJournal(fx, a, 'R12MAY', '2026-05-10', fuel());
    const pMay = await contra(bMay.id, 150);
    const sMay = await shareOn('2026-05-31', 'SHARE-MAY');
    const bJun = await billWithJournal(fx, a, 'R12JUN', '2026-06-10', fuel());
    await contra(bJun.id, 150);
    await shareOn('2026-06-30', 'SHARE-JUN');
    await handOn('2026-06-30', 'hand undo of R12JUN (June share)');
    const r = await undo(pMay, sMay);
    expect(r.isError, text(r)).toBeFalsy();
  }, 120000);

  it('REPRO 13: a hand undo reinstated by reversal-of-reversal is not counted -> bill restored twice', async () => {
    const vat0 = await vatMay();
    const b = await billWithJournal(fx, a, 'R13', '2026-05-10', fuel());
    const p = await contra(b.id, 150);
    const s = await shareOn('2026-05-31', 'SHARE-13');
    const h = await handOn('2026-05-31', 'hand undo R13');
    const r1 = await rev(h);
    await rev((r1 as unknown as { reversalId?: string; id?: string; reversal?: { id: string } }).reversal?.id
      ?? String((await sql`SELECT id FROM gl_journal_entries WHERE reversal_of_id = ${h}::UUID`) as Row[] && ((await sql`SELECT id FROM gl_journal_entries WHERE reversal_of_id = ${h}::UUID`) as Row[])[0]!.id));
    const r = await undo(p, s);
    expect({ refused: r.isError === true, vatDelta: r2(await vatMay() - vat0) }).toEqual({ refused: true, vatDelta: 19.57 });
  }, 120000);

  it('REPRO 14: a hand undo dated before the share date is not counted', async () => {
    const vat0 = await vatMay();
    const b = await billWithJournal(fx, a, 'R14', '2026-05-10', fuel());
    const p = await contra(b.id, 150);
    const s = await shareOn('2026-05-31', 'SHARE-14');
    await handOn('2026-05-20', 'hand undo R14 dated on the bill month');
    const r = await undo(p, s);
    expect({ refused: r.isError === true, vatDelta: r2(await vatMay() - vat0) }).toEqual({ refused: true, vatDelta: 19.57 });
  }, 120000);

  // Round 4: moved to 2026-07 — every same-month hand undo on these accounts now counts against a share
  // (refusing-side limit), and an earlier repro in this file leaves one in May.
  it('CHECK 15: undo -> reverse undo -> reverse share -> re-post share -> new contra -> undo again nets once', async () => {
    const vat0 = await vat07();
    const b = await billWithJournal(fx, a, 'R15', '2026-07-10', fuel());
    const p = await contra(b.id, 150);
    const s = await shareOn('2026-07-31', 'SHARE-15');
    const u = await undo(p, s);
    expect(u.isError, text(u)).toBeFalsy();
    let shareRevRefusedWhileLive = false;
    try { await rev(s); } catch { shareRevRefusedWhileLive = true; }
    await rev(JSON.parse(text(u)).undo_share.journal_entry_ids[0]);
    let shareRevError: string | null = null;
    try { await rev(s); } catch (e) { shareRevError = (e as Error).message; }
    const s2 = await shareOn('2026-07-31', 'SHARE-15-REDATED');
    const p2 = await contra(b.id, 150);
    const u2 = await undo(p2, s2);
    const l = await ledger(fx);
    expect({ shareRevRefusedWhileLive, shareRevError,
      u2: u2.isError && /a share re-dated by reverse-and-repost/.test(text(u2)) ? 'refused: re-date fingerprint' : text(u2), vatDelta: r2(await vat07() - vat0), balanced: l.balanced })
      // Round 5 (rule change, breaker REPRO 20): the reversed share s in the window is the re-date fingerprint, so the
      // undo against s2 is refused outright (was: 'ok', delta 19.57). Refused, b's share stays taken by s2: delta 0.
      .toEqual({ shareRevRefusedWhileLive: true, shareRevError: null, u2: 'refused: re-date fingerprint', vatDelta: 0, balanced: true });
  }, 120000);
});
