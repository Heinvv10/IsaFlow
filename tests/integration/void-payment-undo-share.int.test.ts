/**
 * void_payment(undo_share) against a real ledger (step 6). Velocity's pattern, generically: a bill (two expense legs,
 * one with a CC1, and input VAT) settled by a contra that credits a clearing account; a share journal that took the
 * bill's expense and VAT back out of the clearing account (DR clearing / CR legs, two bills in one journal, as the
 * month-end journals do); then the contra voided WITH its share undone, through the MCP registry.
 *
 * Pinned: the undo mirrors the bill's own split (accounts, CC1, VAT code) on the share's date; the clearing account
 * nets to nil; the ledger balances; May's VAT201 input tax rises by the bill's VAT; AP control = the subledger; a dry
 * run writes nothing and leaves the idempotency key for the live call; a share that carries other bills needs
 * undo_amounts. The refusals are in void-payment-undo-share-refusals.int.test.ts; the breaker's repros in
 * breaker6-undo.int.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { getVATReturn } from '@/modules/accounting/services/reports/vatReturnService';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, seedFixture, type Fixture } from './helpers/l1FifoFixture';
import {
  apSubledger, billWithJournal, dropStepExtras, ledger, postedJournal, seedStepAccounts, type StepAccounts,
} from './helpers/shareUndoFixture';
import { text, undoShareKit } from './helpers/undoShareKit';

const DATABASE_URL = process.env.DATABASE_URL;
type Row = Record<string, unknown>;
let fx: Fixture;
let a: StepAccounts;
const { call, contra, payStatus, scenario } = undoShareKit(() => fx, () => a);
const undoCount = async () => Number(((await sql`
  SELECT COUNT(*)::INT AS n FROM gl_journal_entries WHERE company_id = ${fx.companyId}::UUID AND reference LIKE 'undo-share:%'`) as Row[])[0]!.n);
const inputTaxMay = async () => (await getVATReturn(fx.companyId, '2026-05-01', '2026-05-31')).totalInputTax;

describe.skipIf(!DATABASE_URL)('void_payment undo_share — the share comes back out of the clearing account', () => {
  let billA: { id: string; total: number };
  let payA: string;
  let share: string;

  beforeAll(async () => {
    assertNotProductionDb('This test posts journals and voids payments.');
    fx = await seedFixture('UNDO', DATABASE_URL!);
    a = await seedStepAccounts(fx);
    billA = await billWithJournal(fx, a, 'SIVA', '2026-05-10', [
      { account: a.expense, debit: 5000, cc1Id: a.cc1, costCenterId: a.cc1 }, { account: a.expense2, debit: 1956.52 },
      { account: a.vatInput, debit: 1043.48, vatType: 'standard' }]);
    const billB = await billWithJournal(fx, a, 'SIVB', '2026-05-12', [
      { account: a.expense, debit: 130.43 }, { account: a.vatInput, debit: 19.57, vatType: 'standard' }]);
    payA = await contra(billA.id, 8000);
    await contra(billB.id, 150);
    share = await postedJournal(fx, '2026-05-31', [
      { account: a.clearing, debit: 8150 }, { account: a.expense, credit: 5130.43 }, { account: a.expense2, credit: 1956.52 },
      { account: a.vatInput, credit: 1063.05, vatType: 'standard' }], 'JE-SHARE-MAY');
  }, 120000);

  afterAll(async () => {
    await dropStepExtras(fx);
    await dropFixture(fx);
  }, 120000);

  it('dry run writes nothing; the live call on the same key voids and posts the mirror of the bill', async () => {
    const before = await ledger(fx);
    const vatBefore = await inputTaxMay();
    expect(before.by[a.clearing]).toBe(0);
    // The May share carries bill B too (8,150 > the 8,000 this payment applied): without undo_amounts it is refused.
    const bare = await call({ payment_id: payA, undo_share: true, share_journal_id: share, idempotency_key: crypto.randomUUID() });
    expect(text(bare)).toMatch(/carries other bills too.*Pass undo_amounts/);
    expect(await payStatus(payA)).toBe('processed');
    const key = crypto.randomUUID();
    const args = { payment_id: payA, undo_share: true, share_journal_id: share, idempotency_key: key,
      undo_amounts: [{ bill_id: billA.id, amount: 8000 }] };

    const dry = await call({ ...args, dry_run: true });
    expect(dry.isError, text(dry)).toBeFalsy();
    const preview = JSON.parse(text(dry));
    expect(preview).toMatchObject({ dryRun: true, voided: false, would_void: true, amount_unapplied: 8000 });
    expect(preview.undo_share.journals[0].lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ account_id: a.expense, debit: 5000, cc1_id: a.cc1 }),
      expect.objectContaining({ account_id: a.expense2, debit: 1956.52 }),
      expect.objectContaining({ account_id: a.vatInput, debit: 1043.48, vat_type: 'standard' }),
      expect.objectContaining({ account_id: a.clearing, credit: 8000 })]));
    expect(await ledger(fx)).toEqual(before);
    expect(await payStatus(payA)).toBe('processed');
    expect(await undoCount()).toBe(0);

    const live = await call(args);
    expect(live.isError, text(live)).toBeFalsy();
    const out = JSON.parse(text(live));
    expect(out.voided).toBe(true);
    const [undoId] = out.undo_share.journal_entry_ids as string[];
    const [head] = (await sql`SELECT entry_date::TEXT AS d, reference, status, posting_agent FROM gl_journal_entries
      WHERE id = ${undoId!}::UUID AND company_id = ${fx.companyId}::UUID`) as Row[];
    expect(head).toMatchObject({ d: '2026-05-31', reference: `undo-share:${payA}:${billA.id}`, status: 'posted' });
    expect(String(head!.posting_agent)).toMatch(/void_payment/);
    const lines = (await sql`SELECT gl_account_id::TEXT AS g, debit::float8 AS d, credit::float8 AS c, vat_type, cc1_id::TEXT AS cc1
      FROM gl_journal_lines WHERE journal_entry_id = ${undoId!}::UUID ORDER BY debit DESC, credit DESC`) as Row[];
    expect(lines).toEqual([
      { g: a.clearing, d: 0, c: 8000, vat_type: null, cc1: null },
      { g: a.expense, d: 5000, c: 0, vat_type: null, cc1: a.cc1 },
      { g: a.expense2, d: 1956.52, c: 0, vat_type: null, cc1: null },
      { g: a.vatInput, d: 1043.48, c: 0, vat_type: 'standard', cc1: null },
    ].sort((x, y) => (y.d - x.d) || (y.c - x.c)));

    const after = await ledger(fx);
    expect(after.balanced).toBe(true);
    expect(after.by[a.clearing]).toBe(0);
    expect(Math.round((await inputTaxMay() - vatBefore) * 100) / 100).toBe(1043.48);
    expect(-(after.by[a.ap] ?? 0)).toBe(await apSubledger(fx));
    expect(await apSubledger(fx)).toBe(8000);
    expect(await payStatus(payA)).toBe('cancelled');

    const replay = await call(args);
    expect(JSON.parse(text(replay)).undo_share.journal_entry_ids).toEqual([undoId]);
    expect(await undoCount()).toBe(1);
  }, 120000);

  it('a contra over two bills, one part-applied: one undo per bill, each for what THIS payment applied to it', async () => {
    const legs = [{ account: a.expense, debit: 1000 }, { account: a.vatInput, debit: 150, vatType: 'standard' }];
    const full = await billWithJournal(fx, a, 'MULTI1', '2026-05-10', legs);
    const half = await billWithJournal(fx, a, 'MULTI2', '2026-05-11', legs);
    const je = await postedJournal(fx, '2026-09-17', [{ account: a.ap, debit: 1725 }, { account: a.clearing, credit: 1725 }]);
    const [p] = (await sql`INSERT INTO supplier_payments (company_id, supplier_id, payment_date, total_amount, payment_method,
        bank_account_id, status, created_by, gl_journal_entry_id)
      VALUES (${fx.companyId}::UUID, ${fx.supplierId}::UUID, '2026-09-17', 1725, 'contra', ${a.clearing}::UUID, 'processed',
              ${fx.userId}::UUID, ${je}::UUID) RETURNING id`) as Row[];
    const payId = String(p!.id);
    for (const [b, amt] of [[full.id, 1150], [half.id, 575]] as const) {
      await sql`INSERT INTO payment_allocations (payment_id, invoice_id, amount_allocated) VALUES (${payId}::UUID, ${b}::UUID, ${amt})`;
      await sql`UPDATE supplier_invoices SET amount_paid = ${amt}, status = ${amt === 1150 ? 'paid' : 'partially_paid'} WHERE id = ${b}::UUID`;
    }
    const share2 = await postedJournal(fx, '2026-05-31', [{ account: a.clearing, debit: 1725 }, { account: a.expense, credit: 1500 },
      { account: a.vatInput, credit: 225, vatType: 'standard' }]);
    const before = await ledger(fx);
    const out = JSON.parse(text(await call({ payment_id: payId, undo_share: true, share_journal_id: share2, idempotency_key: crypto.randomUUID() })));
    expect(out.undo_share.journals.map((j: { bill_id: string; amount: number }) => [j.bill_id, j.amount]))
      .toEqual([[full.id, 1150], [half.id, 575]].sort((x, y) => String(x[0]).localeCompare(String(y[0]))));
    const halfLines = out.undo_share.journals.find((j: { bill_id: string }) => j.bill_id === half.id).lines;
    expect(halfLines).toEqual(expect.arrayContaining([
      expect.objectContaining({ account_id: a.expense, debit: 500 }), expect.objectContaining({ account_id: a.vatInput, debit: 75 }),
      expect.objectContaining({ account_id: a.clearing, credit: 575 })]));
    const after = await ledger(fx);
    expect(after.balanced).toBe(true);
    // Reversal DR 1725, undo CR 1725: the clearing account is back where it stood.
    expect(after.by[a.clearing]).toBe(before.by[a.clearing]);
    expect(-(after.by[a.ap] ?? 0)).toBe(await apSubledger(fx));
  }, 120000);

  it('a bill posted to a second AP account (any payable subtype) is mirrored', async () => {
    const [ap2] = (await sql`INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
      VALUES (${fx.companyId}::UUID, '2110', ${`Creditors control ${fx.tag}`}, 'liability', 'payable', 'credit', true) RETURNING id`) as Row[];
    const je = await postedJournal(fx, '2026-05-10', [{ account: a.expense, debit: 200 }, { account: String(ap2!.id), credit: 200 }]);
    const [b] = (await sql`INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date, subtotal,
        total_amount, amount_paid, status, created_by, gl_journal_entry_id)
      VALUES (${fx.companyId}::UUID, ${fx.supplierId}::UUID, ${`AP2110-${fx.tag}`}, '2026-05-10', '2026-05-10', 200, 200, 0,
              'approved', ${fx.userId}::UUID, ${je}::UUID) RETURNING id`) as Row[];
    const pay = await contra(String(b!.id), 200);
    const share2 = await postedJournal(fx, '2026-05-31', [{ account: a.clearing, debit: 200 }, { account: a.expense, credit: 200 }]);
    const r = await call({ payment_id: pay, undo_share: true, share_journal_id: share2, idempotency_key: crypto.randomUUID() });
    expect(r.isError, text(r)).toBeFalsy();
  }, 120000);

  it('the remainder cent never lands on a leg that moves a VAT201 figure — a coded base leg included', async () => {
    // 500.35 of a 1,483.33 bill: the coded 1,000 leg and the VAT leg are rounded; the uncoded 333.33 leg takes the rest.
    const s = await scenario('REMAINDER', '2026-05-31', '2026-05-10', [{ account: a.expense, debit: 1000, vatType: 'standard' },
      { account: a.expense2, debit: 333.33 }, { account: a.vatInput, debit: 150, vatType: 'standard' }]);
    const r = await call({ payment_id: s.pay, undo_share: true, share_journal_id: s.share, idempotency_key: crypto.randomUUID(),
      undo_amounts: [{ bill_id: s.bill.id, amount: 500.35 }] });
    expect(r.isError, text(r)).toBeFalsy();
    const lines = JSON.parse(text(r)).undo_share.journals[0].lines as { account_id: string; debit: number }[];
    expect(Object.fromEntries(lines.filter((l) => l.debit > 0).map((l) => [l.account_id, l.debit])))
      .toEqual({ [a.expense]: 337.32, [a.expense2]: 112.43, [a.vatInput]: 50.6 });
  }, 120000);

  it('undo_share without write:journals is refused before the void, dry run and live alike', async () => {
    const s = await scenario('NOSCOPE', '2026-05-31');
    const before = await ledger(fx);
    for (const dry of [true, false]) {
      const r = await call({ payment_id: s.pay, undo_share: true, share_journal_id: s.share, dry_run: dry,
        idempotency_key: crypto.randomUUID() }, ['write:invoices', 'write:post']);
      expect(text(r)).toMatch(/requires write:journals/);
    }
    expect(await payStatus(s.pay)).toBe('processed');
    expect(await ledger(fx)).toEqual(before);
  }, 120000);

});
