/**
 * D8 round 2: every flow that takes a document's journal OUT of the ledger
 * reverses the chain HEAD (shared/journalChainHead), not the original.
 *
 * After O <- R <- R2 the ledger carries O again through R2 while O stays
 * stamped `reversed_at`. Read by the stamp, a cancel skipped the reversal and
 * left the cancelled document in the GL, a void either did the same or refused
 * ("already reversed"), and a re-import posted opening balances on top of the
 * standing ones. Each case below builds that chain through reverseJournalEntry
 * (reversing a reversal is an ordinary operation) and asserts the flow leaves
 * the control account NET of the document — the chain reversed once more, at
 * its head, and nothing reversed twice.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { postCustomerInvoiceToGL } from '@/modules/accounting/services/ar/customerPaymentAllocationService';
import { cancelCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceCancelService';
import { cancelSupplierInvoice, postSupplierInvoiceToGL } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { planSupplierInvoiceCancel } from '@/modules/accounting/services/ap/supplierInvoiceCancelPlan';
import { processSupplierPayment, voidSupplierPayment } from '@/modules/accounting/services/ap/supplierPaymentWorkflowService';
import { voidPaymentDocument } from '@/modules/accounting/services/core/paymentVoidService';
import { importOpeningBalances } from '@/modules/accounting/services/core/migrationImportService';
import { findJournalChainHead, JournalChainBrokenError } from '@/modules/accounting/services/shared/journalChainHead';
import { journalInForceAsAtFragment, journalStandsFragment } from '@/modules/accounting/services/shared/journalInForceAsAt';
import { softDelete } from '@/modules/accounting/services/core/softDeleteService';
import { SoftDeleteRefusalError } from '@/modules/accounting/services/core/softDeleteErrors';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, inTx, seedFixture, type Fixture } from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
type Row = Record<string, unknown>;
let fx: Fixture;
const acct: Record<string, string> = {};
let seq = 0;

/** Posted net (debit − credit) of one account, every posted entry counted — reversals are posted too. */
async function net(accountId: string): Promise<number> {
  const [r] = (await sql`
    SELECT COALESCE(SUM(l.debit - l.credit), 0)::float8 AS n
    FROM gl_journal_lines l JOIN gl_journal_entries e ON e.id = l.journal_entry_id
    WHERE l.company_id = ${fx.companyId}::UUID AND e.company_id = ${fx.companyId}::UUID
      AND e.status = 'posted' AND l.gl_account_id = ${accountId}::UUID`) as Row[];
  return Math.round(Number(r!.n) * 100) / 100;
}

/** O <- R <- R2 through the product; returns R2, the head. */
async function reverseTwice(id: string): Promise<string> {
  const r = await inTx(fx, () => reverseJournalEntry(fx.companyId, id, fx.userId));
  return (await inTx(fx, () => reverseJournalEntry(fx.companyId, r.id, fx.userId))).id;
}

const reversalOf = async (id: string) => ((await sql`
  SELECT id FROM gl_journal_entries
  WHERE company_id = ${fx.companyId}::UUID AND reversal_of_id = ${id}::UUID AND status = 'posted'`) as Row[])
  .map((r) => String(r.id));

async function journalOf(table: 'customer_invoices' | 'supplier_invoices' | 'supplier_payments', id: string) {
  const [r] = table === 'customer_invoices'
    ? (await sql`SELECT gl_journal_entry_id AS j FROM customer_invoices WHERE id = ${id}::UUID`) as Row[]
    : table === 'supplier_invoices'
      ? (await sql`SELECT gl_journal_entry_id AS j FROM supplier_invoices WHERE id = ${id}::UUID`) as Row[]
      : (await sql`SELECT gl_journal_entry_id AS j FROM supplier_payments WHERE id = ${id}::UUID`) as Row[];
  return String(r!.j);
}

async function postedBill(): Promise<string> {
  const [b] = (await sql`
    INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date,
      status, subtotal, tax_amount, total_amount, amount_paid, created_by)
    VALUES (${fx.companyId}::UUID, ${fx.supplierId}::UUID, ${`D8B-${++seq}-${fx.tag}`}, '2026-05-10', '2026-06-10',
      'approved', 1000, 150, 1150, 0, ${fx.userId}::UUID)
    RETURNING id`) as Row[];
  const id = String(b!.id);
  await sql`
    INSERT INTO supplier_invoice_items (supplier_invoice_id, description, quantity, unit_price, tax_rate, tax_amount, line_total, gl_account_id)
    VALUES (${id}::UUID, 'D8 line', 1, 1000, 15, 150, 1000, ${acct.expense}::UUID)`;
  await inTx(fx, () => postSupplierInvoiceToGL(fx.companyId, id, fx.userId));
  return id;
}

/** A processed supplier payment of R`amount` against `billId`, through the real workflow. */
async function processedPayment(billId: string, amount: number): Promise<string> {
  const [p] = (await sql`
    INSERT INTO supplier_payments (company_id, payment_number, supplier_id, payment_date, total_amount, status,
      payment_method, bank_account_id, created_by)
    VALUES (${fx.companyId}::UUID, ${`D8P${++seq}-${fx.tag.slice(-12)}`}, ${fx.supplierId}::UUID, '2026-05-20', ${amount},
      'approved', 'eft', ${fx.bankAccountId}::UUID, ${fx.userId}::UUID)
    RETURNING id`) as Row[];
  const id = String(p!.id);
  await sql`INSERT INTO payment_allocations (payment_id, invoice_id, amount_allocated) VALUES (${id}::UUID, ${billId}::UUID, ${amount})`;
  await inTx(fx, () => processSupplierPayment(fx.companyId, id, fx.userId));
  return id;
}

async function postedInvoice(): Promise<string> {
  const [i] = (await sql`
    INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date, due_date,
      status, subtotal, tax_rate, tax_amount, total_amount, amount_paid, created_by)
    VALUES (${fx.companyId}::UUID, ${fx.customerId}::UUID, ${fx.customerId}::UUID, ${`D8I-${++seq}-${fx.tag}`},
      '2026-05-10', '2026-06-10', 'approved', 1000, 15, 150, 1150, 0, ${fx.userId}::UUID)
    RETURNING id`) as Row[];
  const invoice = String(i!.id);
  await inTx(fx, () => postCustomerInvoiceToGL(fx.companyId, invoice, fx.userId));
  return invoice;
}

describeIfDb('D8 round 2: a re-reversed journal is taken out of the ledger at its chain head', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test posts, reverses, cancels and voids journals.');
    fx = await seedFixture('D8R2', DATABASE_URL!);
    for (const [k, sub] of [['ar', 'receivable'], ['ap', 'payable'], ['expense', 'default_expense'], ['bank', 'bank']]) {
      acct[k] = String(((await sql`
        SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID AND account_subtype = ${sub}`) as Row[])[0]!.id);
    }
    await sql`
      INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active, is_system_account)
      VALUES (${fx.companyId}::UUID, '4000', ${`Sales ${fx.tag}`}, 'revenue', 'default_revenue', 'credit', true, true),
             (${fx.companyId}::UUID, '3900', ${`Opening equity ${fx.tag}`}, 'equity', 'opening_balance_equity', 'credit', true, true)`;
  }, 120000);

  afterAll(async () => {
    if (!fx) return;
    const c = fx.companyId;
    await sql`DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN (SELECT id FROM supplier_invoices WHERE company_id = ${c}::UUID)`;
    await sql`DELETE FROM migration_sessions WHERE company_id = ${c}::UUID`;
    await sql`UPDATE gl_journal_entries SET reversal_of_id = NULL WHERE company_id = ${c}::UUID`;
    await dropFixture(fx);
  }, 120000);

  it('AR cancel: reverses the head of a re-reversed approval journal, so the invoice leaves AR', async () => {
    const invoice = await postedInvoice();
    const head = await reverseTwice(await journalOf('customer_invoices', invoice));
    const before = await net(acct.ar!);

    const out = await inTx(fx, () => cancelCustomerInvoice(fx.companyId, invoice, fx.userId));

    expect(await net(acct.ar!)).toBeCloseTo(before - 1150, 2);
    expect(await reversalOf(head)).toEqual([out.reversedJournalEntryId]);
  });

  it('AP cancel: the plan names the head, and the cancel reverses it, so the bill leaves AP', async () => {
    const bill = await postedBill();
    const head = await reverseTwice(await journalOf('supplier_invoices', bill));
    expect((await inTx(fx, () => planSupplierInvoiceCancel(fx.companyId, bill))).journal?.id).toBe(head);
    const before = await net(acct.ap!);

    await inTx(fx, () => cancelSupplierInvoice(fx.companyId, bill, fx.userId));

    expect(await net(acct.ap!)).toBeCloseTo(before + 1150, 2);
    expect(await reversalOf(head)).toHaveLength(1);
  });

  it('payment void: reverses the head of a re-reversed payment journal, so the cash returns to AP', async () => {
    const payment = await processedPayment(await postedBill(), 400);
    const head = await reverseTwice(await journalOf('supplier_payments', payment));
    const before = { ap: await net(acct.ap!), bank: await net(acct.bank!) };

    await inTx(fx, () => voidSupplierPayment(fx.companyId, payment, fx.userId));

    expect(await net(acct.ap!)).toBeCloseTo(before.ap - 400, 2);
    expect(await net(acct.bank!)).toBeCloseTo(before.bank + 400, 2);
    expect(await reversalOf(head)).toHaveLength(1);
  });

  it('MCP void (no bank line): reverses the head instead of refusing "already reversed"', async () => {
    const payment = await processedPayment(await postedBill(), 300);
    const head = await reverseTwice(await journalOf('supplier_payments', payment));
    const before = await net(acct.ap!);

    await inTx(fx, () => voidPaymentDocument(fx.companyId, 'supplier', payment, fx.userId));

    expect(await net(acct.ap!)).toBeCloseTo(before - 300, 2);
    expect(await reversalOf(head)).toHaveLength(1);
  });

  it('a forged reversal LOOP hangs no walk and reverses nothing: the cancel refuses it as broken', async () => {
    const invoice = await postedInvoice();
    const x = await journalOf('customer_invoices', invoice);
    const r = (await inTx(fx, () => reverseJournalEntry(fx.companyId, x, fx.userId))).id;
    // X <- R and R <- X: distinct reversal_of_id values, so the unique index allows it.
    await sql`UPDATE gl_journal_entries SET reversal_of_id = ${r}::UUID WHERE id = ${x}::UUID AND company_id = ${fx.companyId}::UUID`;
    const before = await net(acct.ar!);

    const bounded = <T>(fn: () => Promise<T>) => inTx(fx, async () => {
      await sql`SET LOCAL statement_timeout = '5s'`;
      return fn();
    });
    expect(await bounded(() => findJournalChainHead(fx.companyId, x))).toMatchObject({ kind: 'broken', cyclic: true });
    const [read] = (await bounded(async () => sql`
      SELECT ${journalStandsFragment('je.id', fx.companyId)} AS now,
             ${journalInForceAsAtFragment('je.id', '2026-12-31', fx.companyId)} AS asat
      FROM gl_journal_entries je WHERE je.id = ${x}::UUID AND je.company_id = ${fx.companyId}::UUID`)) as Row[];
    expect(typeof read!.now).toBe('boolean');
    expect(typeof read!.asat).toBe('boolean');
    await expect(bounded(() => cancelCustomerInvoice(fx.companyId, invoice, fx.userId))).rejects.toThrow(JournalChainBrokenError);
    expect(await net(acct.ar!)).toBeCloseTo(before, 2);
  });

  // brk-d7 pass 2, F1 (P8): softDeleteJournalService.chainHead was an unguarded
  // recursive walk. A looped chain on a LIVE invoice made the delete spin, holding
  // its FOR UPDATE locks, until something cancelled the backend. It now walks
  // through shared/journalChainHead, which stops at the first repeat.
  it('soft delete of an invoice whose journal chain loops is refused at once, books nothing, holds no lock', async () => {
    const invoice = await postedInvoice();
    const o = await journalOf('customer_invoices', invoice);
    const m = (await inTx(fx, () => reverseJournalEntry(fx.companyId, o, fx.userId))).id; // the hand reversal
    await sql`UPDATE gl_journal_entries SET reversal_of_id = ${m}::UUID WHERE id = ${o}::UUID AND company_id = ${fx.companyId}::UUID`;
    const before = await net(acct.ar!);
    const started = Date.now();

    await expect(inTx(fx, async () => {
      await sql`SET LOCAL statement_timeout = '5s'`;
      return softDelete(fx.companyId, 'customer_invoice', invoice, fx.userId);
    })).rejects.toThrow(SoftDeleteRefusalError);

    expect(Date.now() - started).toBeLessThan(4000);
    expect(await net(acct.ar!)).toBeCloseTo(before, 2);
    const [row] = (await sql`SELECT deleted_at FROM customer_invoices WHERE id = ${invoice}::UUID`) as Row[];
    expect(row!.deleted_at).toBeNull();
    // The refused request's row locks are gone: both rows lock at once from another transaction.
    const locked = await inTx(fx, async () => (await sql`
      SELECT id FROM gl_journal_entries WHERE id IN (${o}::UUID, ${m}::UUID) AND company_id = ${fx.companyId}::UUID
      FOR UPDATE NOWAIT`) as Row[]);
    expect(locked).toHaveLength(2);
  });

  it('opening-balance re-import: a standing re-reversed take-on is reversed at its head, not posted on top of', async () => {
    const [s] = (await sql`
      INSERT INTO migration_sessions (company_id, source_system, started_by)
      VALUES (${fx.companyId}::UUID, 'sage', ${fx.userId}) RETURNING id`) as Row[];
    const session = String(s!.id);
    const tb = [{ accountCode: '6000', debit: 700, credit: 0 }, { accountCode: '3900', debit: 0, credit: 700 }];
    const expenseBefore = await net(acct.expense!);
    const first = await inTx(fx, () => importOpeningBalances(fx.companyId, session, '2026-01-01', tb, fx.userId));
    const head = await reverseTwice(first.journalEntryId);

    await inTx(fx, () => importOpeningBalances(fx.companyId, session, '2026-01-01', tb, fx.userId));

    expect(await net(acct.expense!)).toBeCloseTo(expenseBefore + 700, 2);
    expect(await reversalOf(head)).toHaveLength(1);
  });
});
