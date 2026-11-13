/**
 * void_payment(undo_share) against a real ledger (step 6). Velocity's pattern, generically: a bill (two expense legs,
 * one with a CC1, and input VAT) settled by a contra that credits a clearing account; a share journal that took the
 * bill's expense and VAT back out of the clearing account (DR clearing / CR legs, two bills in one journal, as the
 * month-end journals do); then the contra voided WITH its share undone, through the MCP registry.
 *
 * Pinned: the undo mirrors the bill's own split (accounts, CC1, VAT code) on the share's date; the clearing account
 * nets to nil; the ledger balances; May's VAT201 input tax rises by the bill's VAT; AP control = the subledger; a dry
 * run writes nothing and leaves the idempotency key for the live call. Refusals (nothing written): a share journal
 * that is not the share, a payment that is not a contra, a second undo, a closed period, a VAT-locked period.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { McpRegistry } from '@/lib/mcp/registry';
import { voidPaymentTool } from '@/lib/mcp/tools/writeVoidPayments';
import { settleByContraTool } from '@/lib/mcp/tools/writeSettleByContra';
import { getVATReturn } from '@/modules/accounting/services/reports/vatReturnService';
import type { McpToolContext } from '@/lib/mcp/types';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, inTx, seedFixture, type Fixture } from './helpers/l1FifoFixture';
import {
  apSubledger, billWithJournal, dropStepExtras, ledger, postedJournal, seedStepAccounts, type StepAccounts,
} from './helpers/shareUndoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
type Row = Record<string, unknown>;
let fx: Fixture;
let a: StepAccounts;
const registry = new McpRegistry();
registry.register(voidPaymentTool);
const ctx = (): McpToolContext => ({
  userId: fx.userId, companyId: fx.companyId, scopes: ['write:invoices', 'write:post'], companyRole: 'owner',
  tokenJti: 'step6', oauthAppId: null,
} as McpToolContext);
const call = (args: Row) => inTx(fx, () => registry.call('void_payment', args, ctx()));
const text = (r: { content: { text: string }[] }) => r.content[0]!.text;

async function contra(billId: string, amount: number): Promise<string> {
  const r = await inTx(fx, () => settleByContraTool.handler({
    subledger: 'ap', document_id: billId, contra_account_id: a.clearing, amount, reason: 'petty cash via paycards',
    settlement_date: '2026-09-17', idempotency_key: crypto.randomUUID(),
  }, ctx()));
  expect(r.isError, text(r)).toBeFalsy();
  return String(JSON.parse(text(r)).payment_id);
}
const payStatus = async (id: string) => String(((await sql`SELECT status FROM supplier_payments WHERE id = ${id}::UUID`) as Row[])[0]!.status);
const undoCount = async () => Number(((await sql`
  SELECT COUNT(*)::INT AS n FROM gl_journal_entries WHERE company_id = ${fx.companyId}::UUID AND reference LIKE 'undo-share:%'`) as Row[])[0]!.n);
const inputTaxMay = async () => (await getVATReturn(fx.companyId, '2026-05-01', '2026-05-31')).totalInputTax;

/** A bill of `total` (expense + 15% VAT), settled by a contra, and a share journal dated `shareDate` that carried it. */
async function scenario(tag: string, shareDate: string, billDate = '2026-05-10', shareLegs?: (n: number, v: number) => Parameters<typeof postedJournal>[2]) {
  const bill = await billWithJournal(fx, a, tag, billDate, [{ account: a.expense, debit: 1000 }, { account: a.vatInput, debit: 150, vatType: 'standard' }]);
  const pay = await contra(bill.id, 1150);
  const share = await postedJournal(fx, shareDate, shareLegs?.(1000, 150) ?? [
    { account: a.clearing, debit: 1150 }, { account: a.expense, credit: 1000 }, { account: a.vatInput, credit: 150, vatType: 'standard' }]);
  return { bill, pay, share };
}

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
    await sql`DELETE FROM approval_rules WHERE company_id = ${fx.companyId}::UUID AND name = 'step6 big journals'`;
    await sql`DELETE FROM approval_enforcement WHERE company_id = ${fx.companyId}::UUID AND document_type = 'manual_journal'`;
    await dropStepExtras(fx);
    await dropFixture(fx);
  }, 120000);

  it('dry run writes nothing; the live call on the same key voids and posts the mirror of the bill', async () => {
    const before = await ledger(fx);
    const vatBefore = await inputTaxMay();
    expect(before.by[a.clearing]).toBe(0);
    const key = crypto.randomUUID();
    const args = { payment_id: payA, undo_share: true, share_journal_id: share, idempotency_key: key };

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

  it('refuses a share journal that is not the share, and one that misses a bill account — nothing written', async () => {
    const s = await scenario('WRONG', '2026-05-31');
    const notShare = await postedJournal(fx, '2026-05-31', [{ account: a.expense, debit: 1150 }, { account: a.bank, credit: 1150 }]);
    expect(text(await call({ payment_id: s.pay, undo_share: true, share_journal_id: notShare, idempotency_key: crypto.randomUUID() })))
      .toMatch(/does not debit .*1560731/);
    const thin = await postedJournal(fx, '2026-05-31', [{ account: a.clearing, debit: 1150 }, { account: a.expense2, credit: 1000 },
      { account: a.vatInput, credit: 150, vatType: 'standard' }]);
    expect(text(await call({ payment_id: s.pay, undo_share: true, share_journal_id: thin, idempotency_key: crypto.randomUUID() })))
      .toMatch(/does not credit account 6000/);
    expect(text(await call({ payment_id: s.pay, undo_share: true, share_journal_id: crypto.randomUUID(), idempotency_key: crypto.randomUUID() })))
      .toBe('share_journal_id is not a journal of this company.');
    expect(await payStatus(s.pay)).toBe('processed');
  }, 120000);

  it('refuses a payment that is not a contra (it paid from the bank)', async () => {
    const bill = await billWithJournal(fx, a, 'BANKPAID', '2026-05-10', [{ account: a.expense, debit: 100 }]);
    const je = await postedJournal(fx, '2026-06-01', [{ account: a.ap, debit: 100 }, { account: a.bank, credit: 100 }]);
    const [p] = (await sql`INSERT INTO supplier_payments (company_id, supplier_id, payment_date, total_amount, payment_method,
        bank_account_id, status, created_by, gl_journal_entry_id)
      VALUES (${fx.companyId}::UUID, ${fx.supplierId}::UUID, '2026-06-01', 100, 'eft', ${a.bank}::UUID, 'processed',
              ${fx.userId}::UUID, ${je}::UUID) RETURNING id`) as Row[];
    await sql`INSERT INTO payment_allocations (payment_id, invoice_id, amount_allocated) VALUES (${String(p!.id)}::UUID, ${bill.id}::UUID, 100)`;
    await sql`UPDATE supplier_invoices SET amount_paid = 100, status = 'paid' WHERE id = ${bill.id}::UUID`;
    expect(text(await call({ payment_id: String(p!.id), undo_share: true, share_journal_id: share, idempotency_key: crypto.randomUUID() })))
      .toMatch(/is not a contra settlement/);
    expect(await payStatus(String(p!.id))).toBe('processed');
  }, 120000);

  it('refuses a contra whose journal also posted another payment document', async () => {
    const je = await postedJournal(fx, '2026-09-17', [{ account: a.ap, debit: 200 }, { account: a.clearing, credit: 200 }]);
    const ids: string[] = [];
    for (const n of ['SIB1', 'SIB2']) {
      const b = await billWithJournal(fx, a, n, '2026-05-10', [{ account: a.expense, debit: 100 }]);
      const [p] = (await sql`INSERT INTO supplier_payments (company_id, supplier_id, payment_date, total_amount, payment_method,
          bank_account_id, status, created_by, gl_journal_entry_id)
        VALUES (${fx.companyId}::UUID, ${fx.supplierId}::UUID, '2026-09-17', 100, 'contra', ${a.clearing}::UUID, 'processed',
                ${fx.userId}::UUID, ${je}::UUID) RETURNING id`) as Row[];
      await sql`INSERT INTO payment_allocations (payment_id, invoice_id, amount_allocated) VALUES (${String(p!.id)}::UUID, ${b.id}::UUID, 100)`;
      await sql`UPDATE supplier_invoices SET amount_paid = 100, status = 'paid' WHERE id = ${b.id}::UUID`;
      ids.push(String(p!.id));
    }
    const sib = await postedJournal(fx, '2026-05-31', [{ account: a.clearing, debit: 200 }, { account: a.expense, credit: 200 }]);
    expect(text(await call({ payment_id: ids[0], undo_share: true, share_journal_id: sib, idempotency_key: crypto.randomUUID() })))
      .toMatch(/posted other payment documents too/);
    expect(await payStatus(ids[0]!)).toBe('processed');
  }, 120000);

  it('refuses a second undo of the same bill and payment', async () => {
    const s = await scenario('TWICE', '2026-05-31');
    await postedJournal(fx, '2026-05-31', [{ account: a.expense, debit: 1 }, { account: a.clearing, credit: 1 }], `undo-share:${s.pay}:${s.bill.id}`);
    expect(text(await call({ payment_id: s.pay, undo_share: true, share_journal_id: s.share, idempotency_key: crypto.randomUUID() })))
      .toMatch(/was already undone by JE-/);
    expect(await payStatus(s.pay)).toBe('processed');
  }, 120000);

  it('refuses (never rolls) a share date in a closed period or a locked VAT period', async () => {
    await sql`INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
      VALUES (${fx.companyId}::UUID, ${`FY25 ${fx.tag}`}, 1, 2025, '2025-01-01', '2025-12-31', 'closed')`;
    const closed = await scenario('CLOSED', '2025-12-31', '2025-11-10');
    expect(text(await call({ payment_id: closed.pay, undo_share: true, share_journal_id: closed.share, idempotency_key: crypto.randomUUID() })))
      .toMatch(/2025-12-31, which is not in an open fiscal period/);
    expect(await payStatus(closed.pay)).toBe('processed');

    const locked = await scenario('LOCKED', '2026-03-31', '2026-03-10');
    await sql`INSERT INTO vat_period_locks (company_id, period_start, period_end, output_tax, input_tax, net_vat, posted_through, locked_by)
      VALUES (${fx.companyId}::UUID, '2026-03-01', '2026-03-31', 0, 0, 0, NOW(), 'step6 test')`;
    expect(text(await call({ payment_id: locked.pay, undo_share: true, share_journal_id: locked.share, idempotency_key: crypto.randomUUID() })))
      .toMatch(/inside the locked VAT period 2026-03-01 to 2026-03-31/);
    expect(await payStatus(locked.pay)).toBe('processed');
  }, 120000);

  it('R-035: under manual-journal enforcement a matching rule refuses the call, dry run and live alike', async () => {
    const s = await scenario('R035', '2026-05-31');
    await sql`INSERT INTO approval_enforcement (company_id, document_type, enabled_by) VALUES (${fx.companyId}::UUID, 'manual_journal', 'step6')`;
    await sql`INSERT INTO approval_rules (company_id, name, document_type, condition_field, condition_operator, condition_value, approver_role, is_active)
      VALUES (${fx.companyId}::UUID, 'step6 big journals', 'manual_journal', 'amount', 'greater_than', 1000, 'owner', true)`;
    const args = { payment_id: s.pay, undo_share: true, share_journal_id: s.share, idempotency_key: crypto.randomUUID() };
    expect(text(await call({ ...args, dry_run: true }))).toMatch(/Manual journals are enforced/);
    expect(text(await call(args))).toMatch(/Manual journals are enforced/);
    expect(await payStatus(s.pay)).toBe('processed');
  }, 120000);
});
