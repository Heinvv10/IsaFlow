/**
 * L3 — a `settle_by_contra` account is not a control account, and "unapplied"
 * means one thing.
 *
 * WHAT THIS PINS. `getControlAccountBalances` used to UNION the subtype arm
 * with a probe that adopted any account a subledger document's journal had
 * posted to. `settle_by_contra` settles a bill by posting DR Accounts Payable /
 * CR <loan account> THROUGH a `supplier_payments` row, so the loan account was
 * discovered by that probe and counted as an AP control account. On production
 * that produced three "AP control accounts", `controlAccountAmbiguous` true, a
 * `document_not_on_control_account` item of +R453m and an
 * `unexplained_difference` of −R437m — every figure internally consistent and
 * none of it a fact about the books.
 *
 * The contra settlement here is driven through the REAL payment services, not
 * the MCP transport: the loan account reaches the journal as the payment's
 * `bank_account_id`, which is exactly how `settle_by_contra` composes it.
 *
 * AND the second half: `list_unapplied_payments` and `reconcile_subledger` used
 * to define "unapplied" differently — different basis, different threshold,
 * different status filter — and answered the same question with two numbers.
 * They now read `shared/unappliedPaymentBasis.ts`.
 *
 * WHY NO SUB-CENT CASE HERE. `supplier_payments.total_amount` and
 * `payment_allocations.amount_allocated` are both NUMERIC(15,2), so a remainder
 * of R0.004 cannot exist in this database. The rounding rule is pinned on
 * synthetic inputs in tests/unit/services/shared/unappliedPaymentBasis.test.ts;
 * what is seeded here is every remainder the schema can actually hold.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { sql, getPoolForTests } from '@/lib/neon';
import { postCustomerInvoiceToGL, confirmCustomerPayment } from '@/modules/accounting/services/ar/customerPaymentAllocationService';
import { postSupplierInvoiceToGL } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteApproveService';
import { cancelCreditNote } from '@/modules/accounting/services/ar/creditNoteCancelService';
import { processSupplierPayment, voidSupplierPayment } from '@/modules/accounting/services/ap/supplierPaymentWorkflowService';
import { getControlAccountBalances } from '@/modules/accounting/services/gl/controlAccountService';
import { reconcileSubledger } from '@/modules/accounting/services/reconciliation/subledgerReconciliationService';
import { getUnappliedPaymentBasis } from '@/modules/accounting/services/shared/unappliedPaymentBasis';
import { getUnappliedPayments } from '@/modules/accounting/services/ap/unappliedPaymentService';
import { getUnappliedReceipts } from '@/modules/accounting/services/ar/unappliedReceiptService';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();
const TAG = `L3C${Math.floor(Math.random() * 1e8)}`;

const DOC_DATE = '2026-03-01';
const SETTLE_DATE = '2026-03-15';
const AS_AT = '2026-06-30';
const SUB = 1000;
const VAT = 150;
const GROSS = SUB + VAT;

let supplier = '';
let customer = '';
let expense = '';
let receivable = '';
let payable = '';
let loan = '';
let bank = '';
let contraBill = '';
let voidedBill = '';
let notedBill = '';
let doubleNotedBill = '';

async function inTx<T>(fn: () => Promise<T>): Promise<T> {
  const client: PoolClient = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    const result = await als.run({ client, userId: USER, companyId: COMPANY, claims: {} }, fn);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function account(
  code: string, name: string, type: string, normal: string, subtype: string | null,
): Promise<string> {
  return ((await sql`
    INSERT INTO gl_accounts (company_id, account_code, account_name, account_type,
      normal_balance, level, is_active, is_system_account, account_subtype)
    VALUES (${COMPANY}::UUID, ${code}, ${name}, ${type}, ${normal}, 3, true, true, ${subtype})
    RETURNING id`) as { id: string }[])[0]!.id;
}

async function bill(n: string): Promise<string> {
  const id = ((await sql`
    INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date,
      status, subtotal, tax_amount, total_amount, amount_paid, created_by)
    VALUES (${COMPANY}::UUID, ${supplier}::UUID, ${TAG + n}, ${DOC_DATE}::date, ${DOC_DATE}::date,
      'approved', ${SUB}, ${VAT}, ${GROSS}, 0, ${USER}::UUID)
    RETURNING id`) as { id: string }[])[0]!.id;
  await sql`
    INSERT INTO supplier_invoice_items (supplier_invoice_id, description, quantity, unit_price,
      tax_rate, tax_amount, line_total, gl_account_id)
    VALUES (${id}::UUID, 'L3 line', 1, ${SUB}, 15, ${VAT}, ${SUB}, ${expense}::UUID)`;
  await inTx(() => postSupplierInvoiceToGL(COMPANY, id, USER));
  return id;
}

/**
 * A supplier payment posted through the real workflow. `bankAccountId` is the
 * credit leg — a loan account for a contra settlement, the bank for a normal
 * one, exactly as `settle_by_contra` composes it.
 */
async function payment(
  n: string, total: number, creditAccount: string, method: string,
  allocations: Array<{ invoiceId: string; amount: number }>,
): Promise<string> {
  const id = ((await sql`
    INSERT INTO supplier_payments (company_id, payment_number, supplier_id, payment_date,
      total_amount, status, payment_method, bank_account_id, created_by)
    VALUES (${COMPANY}::UUID, ${TAG + n}, ${supplier}::UUID, ${SETTLE_DATE}::date,
      ${total}, 'approved', ${method}, ${creditAccount}::UUID, ${USER}::UUID)
    RETURNING id`) as { id: string }[])[0]!.id;
  for (const a of allocations) {
    await sql`
      INSERT INTO payment_allocations (payment_id, invoice_id, amount_allocated)
      VALUES (${id}::UUID, ${a.invoiceId}::UUID, ${a.amount})`;
  }
  await inTx(() => processSupplierPayment(COMPANY, id, USER));
  return id;
}

async function invoice(n: string): Promise<string> {
  const id = ((await sql`
    INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date,
      due_date, status, subtotal, tax_rate, tax_amount, total_amount, amount_paid, created_by)
    VALUES (${COMPANY}::UUID, ${customer}::UUID, ${customer}::UUID, ${TAG + n}, ${DOC_DATE}::date,
      ${DOC_DATE}::date, 'approved', ${SUB}, 15, ${VAT}, ${GROSS}, 0, ${USER}::UUID)
    RETURNING id`) as { id: string }[])[0]!.id;
  await inTx(() => postCustomerInvoiceToGL(COMPANY, id, USER));
  return id;
}

/** A confirmed customer receipt: DR Bank / CR Accounts Receivable. */
async function receipt(
  n: string, total: number, allocations: Array<{ invoiceId: string; amount: number }>,
): Promise<string> {
  const id = ((await sql`
    INSERT INTO customer_payments (company_id, payment_number, client_id, payment_date,
      total_amount, status, created_by)
    VALUES (${COMPANY}::UUID, ${TAG + n}, ${customer}::UUID, ${SETTLE_DATE}::date,
      ${total}, 'draft', ${USER}::UUID)
    RETURNING id`) as { id: string }[])[0]!.id;
  for (const a of allocations) {
    await sql`
      INSERT INTO customer_payment_allocations (payment_id, invoice_id, amount_allocated)
      VALUES (${id}::UUID, ${a.invoiceId}::UUID, ${a.amount})`;
  }
  await inTx(() => confirmCustomerPayment(COMPANY, id, USER));
  return id;
}

/** A credit note linked to a bill, left at draft for the caller to approve. */
async function linkedNote(n: string, invoiceId: string): Promise<string> {
  return ((await sql`
    INSERT INTO credit_notes (company_id, type, supplier_id, supplier_invoice_id,
      credit_note_number, credit_date, subtotal, tax_amount, total_amount, status,
      applied_amount, created_by)
    VALUES (${COMPANY}::UUID, 'supplier', ${supplier}::UUID, ${invoiceId}::UUID,
      ${TAG + n}, ${SETTLE_DATE}::date, ${SUB}, ${VAT}, ${GROSS}, 'draft', 0, ${USER}::UUID)
    RETURNING id`) as { id: string }[])[0]!.id;
}

describeIfDb('L3 — control account by subtype, and one definition of unapplied', () => {
  beforeAll(async () => {
    await sql`INSERT INTO companies (id, name, registration_number)
              VALUES (${COMPANY}::UUID, ${'L3 ' + TAG}, ${TAG})`;
    await sql`INSERT INTO users (id, email, role, is_active)
              VALUES (${USER}, ${USER + '@test.local'}, 'admin', true)`;
    await sql`INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year,
                start_date, end_date, status)
              VALUES (${COMPANY}::UUID, ${'L3 ' + TAG}, 1, 2026, '2026-01-01', '2026-12-31', 'open')`;

    payable = await account('2110', 'Trade Creditors', 'liability', 'credit', 'payable');
    // The contra account: a liability with NO subtype, which is precisely the
    // shape the old posting probe could not exclude.
    loan = await account('2400', 'Director Loan', 'liability', 'credit', null);
    bank = await account('1000', 'Bank', 'asset', 'debit', 'bank');
    expense = await account('5000', 'Materials', 'expense', 'debit', 'default_expense');
    await account('1300', 'VAT Input', 'asset', 'debit', 'vat_input');
    await account('2200', 'VAT Output', 'liability', 'credit', 'vat_output');
    receivable = await account('1120', 'Trade Debtors', 'asset', 'debit', 'receivable');
    await account('4000', 'Sales', 'revenue', 'credit', 'default_revenue');

    supplier = ((await sql`INSERT INTO suppliers (company_id, name)
      VALUES (${COMPANY}::UUID, ${'supp ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;
    customer = ((await sql`INSERT INTO customers (company_id, name)
      VALUES (${COMPANY}::UUID, ${'cust ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;

    // The contra settlement: DR Accounts Payable / CR Director Loan, in full.
    //
    // payment_method is 'eft' rather than 'contra' only because migration 540,
    // which adds 'contra' to the CHECK, is not applied on isaflow_dev. The
    // label is not what this pins: the loan account reaches the journal as
    // `bank_account_id`, which is how settle_by_contra composes it and is what
    // the old posting probe discovered it through.
    contraBill = await bill('-CONTRA');
    await payment('-CONTRA', GROSS, loan, 'eft', [{ invoiceId: contraBill, amount: GROSS }]);

    // Unapplied cash on the control account, at every remainder NUMERIC(15,2)
    // can hold: a whole payment, a one-cent remainder, and nothing left.
    const partBill = await bill('-PART');
    await payment('-WHOLE', 500, bank, 'eft', []);
    await payment('-CENT', 100, bank, 'eft', [{ invoiceId: partBill, amount: 99.99 }]);
    await payment('-NONE', 200, bank, 'eft', [{ invoiceId: await bill('-FULL'), amount: 200 }]);

    // An UNLINKED approved supplier credit note. getAPSubledger has no
    // credit-note leg at all, so before unapplied_credit_note existed this
    // note's journal moved the AP control account and fell into the residual
    // with no name on it.
    const scn = ((await sql`
      INSERT INTO credit_notes (company_id, type, supplier_id, credit_note_number, credit_date,
        subtotal, tax_amount, total_amount, status, applied_amount, created_by)
      VALUES (${COMPANY}::UUID, 'supplier', ${supplier}::UUID, ${TAG + '-SCN'}, ${SETTLE_DATE}::date,
        200, 30, 230, 'draft', 0, ${USER}::UUID)
      RETURNING id`) as { id: string }[])[0]!.id;
    // APPROVED through the real service, so the journal that debits the AP
    // control account exists. An unposted note would give the item no ledger
    // movement to explain and the residual would go to minus its value —
    // which is the whole failure mode this item exists to remove.
    await inTx(() => approveCreditNote(COMPANY, scn, USER));

    // A bill PAID and then the payment VOIDED. Voiding posts a reversal and
    // deletes the allocations, so the control account nets to zero and the bill
    // is open again — neither side moved, and neither leg may be an item. The
    // reversal is not in `soft_delete_journal_reversals` (that table records
    // document soft-deletes), and its ORIGINAL is still claimed by the
    // cancelled payment, so the existing reversal pairing never saw a partner.
    voidedBill = await bill('-VOIDED');
    const voided = await payment('-VOID', GROSS, bank, 'eft', [{ invoiceId: voidedBill, amount: GROSS }]);
    await inTx(() => voidSupplierPayment(COMPANY, voided, USER));

    // A bill credit-noted and the note then CANCELLED. Cancelling reverses the
    // note's journal, so its credit is no longer on the control account — but
    // the note still points at the bill, and counting its original journal
    // against the bill makes the bill look enormously under-represented.
    notedBill = await bill('-NOTED');
    const cancelledNote = ((await sql`
      INSERT INTO credit_notes (company_id, type, supplier_id, supplier_invoice_id,
        credit_note_number, credit_date, subtotal, tax_amount, total_amount, status,
        applied_amount, created_by)
      VALUES (${COMPANY}::UUID, 'supplier', ${supplier}::UUID, ${notedBill}::UUID,
        ${TAG + '-CCN'}, ${SETTLE_DATE}::date, ${SUB}, ${VAT}, ${GROSS}, 'draft', 0, ${USER}::UUID)
      RETURNING id`) as { id: string }[])[0]!.id;
    await inTx(() => approveCreditNote(COMPANY, cancelledNote, USER));
    await inTx(() => cancelCreditNote(COMPANY, cancelledNote, USER));

    // A bill carrying TWO full-value credit notes: one APPLIED (it relieved
    // the bill) and one still APPROVED with applied_amount 0. Both journals
    // debit the AP control account, but only the applied one relieved the
    // subledger, so the unconsumed note is unapplied credit — and counting its
    // whole journal against the bill as well claimed it twice. On the
    // production copy, 12 petty-cash bills were in exactly this state and
    // R5,740.22 was double-counted.
    doubleNotedBill = await bill('-DOUBLE');
    const noteA = await linkedNote('-CNA', doubleNotedBill);
    await inTx(() => approveCreditNote(COMPANY, noteA, USER));
    const noteB = await linkedNote('-CNB', doubleNotedBill);
    await inTx(() => approveCreditNote(COMPANY, noteB, USER));
    // approveCreditNote marks a linked note 'applied' and sets applied_amount,
    // but applyCreditNoteToInvoice refuses supplier notes, so on AP it never
    // moves the bill's amount_paid. The production rows carry the relief on the
    // bill and leave the SECOND note at 'approved' with applied_amount 0 and a
    // posted journal, so the fixture is put into that state directly.
    // Reproducing the state is the point here; how those rows come to exist is
    // a separate question about the apply path.
    await sql`
      UPDATE credit_notes SET status = 'approved', applied_amount = 0
      WHERE id = ${noteB}::UUID AND company_id = ${COMPANY}::UUID`;
    await sql`
      UPDATE supplier_invoices SET amount_paid = ${GROSS}, status = 'paid'
      WHERE id = ${doubleNotedBill}::UUID AND company_id = ${COMPANY}::UUID`;

    // AR: an invoice and a receipt with a one-cent remainder, plus one wholly
    // unapplied, so the AR twin of the payment agreement can be asserted.
    const arBill = await invoice('-AR-PART');
    await receipt('-AR-WHOLE', 300, []);
    await receipt('-AR-CENT', 100, [{ invoiceId: arBill, amount: 99.99 }]);
  }, 180000);

  afterAll(async () => {
    await sql`DELETE FROM customer_payment_allocations WHERE payment_id IN (
      SELECT id FROM customer_payments WHERE company_id = ${COMPANY}::UUID)`;
    await sql`DELETE FROM customer_payments WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM credit_notes WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM customer_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM payment_allocations WHERE payment_id IN (
      SELECT id FROM supplier_payments WHERE company_id = ${COMPANY}::UUID)`;
    await sql`DELETE FROM supplier_payments WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN (
      SELECT id FROM supplier_invoices WHERE company_id = ${COMPANY}::UUID)`;
    await sql`DELETE FROM supplier_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM gl_journal_lines WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM gl_journal_entries WHERE company_id = ${COMPANY}::UUID
              AND reversal_of_id IS NOT NULL`;
    await sql`DELETE FROM gl_journal_entries WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM gl_account_balances WHERE gl_account_id IN (
      SELECT id FROM gl_accounts WHERE company_id = ${COMPANY}::UUID)`;
    await sql`DELETE FROM gl_accounts WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM fiscal_periods WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM suppliers WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM customers WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM users WHERE id = ${USER}`;
    await sql`DELETE FROM companies WHERE id = ${COMPANY}::UUID`;
  }, 120000);

  it('the contra account is NOT an AP control account, and the bill is settled', async () => {
    const accounts = await getControlAccountBalances(COMPANY, 'ap', AS_AT);
    expect(accounts.map((a) => a.accountCode)).toEqual(['2110']);
    expect(accounts[0]!.accountId).toBe(payable);
    expect(accounts.some((a) => a.accountId === loan)).toBe(false);

    const rec = await reconcileSubledger(COMPANY, 'ap', AS_AT);
    expect(rec.controlAccounts).toHaveLength(1);
    expect(rec.controlAccountAmbiguous).toBe(false);

    // The AP leg of the contra journal IS on the control account, so the bill
    // is settled and names no item. Adopting the loan account instead put this
    // bill's whole value into document_not_on_control_account.
    const naming = rec.reconcilingItems.filter((i) => i.documentIds.includes(contraBill));
    expect(naming).toEqual([]);
  }, 120000);

  it('decomposes the difference into items that sum to it, with every invariant holding', async () => {
    const rec = await reconcileSubledger(COMPANY, 'ap', AS_AT);
    const named = rec.reconcilingItems
      .filter((i) => i.bridge === 'subledger_to_control' && i.type !== 'unexplained_difference')
      .reduce((s, i) => s + i.amount, 0);
    // Asserted on the NAMED items: including the residual makes the identity
    // true by construction, because the residual is defined as what closes it.
    expect(rec.unexplainedDifference).toBeCloseTo(rec.difference! - named, 2);
    expect(rec.unexplainedDifference).toBe(0);

    for (const inv of rec.invariants) {
      expect(inv, `${inv.name}: ${inv.detail}`).toMatchObject({ holds: true });
    }
    expect(rec.invariants.map((i) => i.name)).toEqual([
      'control_plus_items_equals_subledger',
      'item_within_cited_gross',
      'unexplained_is_the_residual',
    ]);
  }, 120000);

  it('list_unapplied_payments and the reconciler count the same cash', async () => {
    const listed = await getUnappliedPayments(COMPANY, { asAt: AS_AT, limit: 200 });
    const basis = await getUnappliedPaymentBasis(COMPANY, 'ap', AS_AT);

    // R500 wholly unapplied and R0.01 left on the R100 payment. The fully
    // applied R200 and the contra settlement are not unapplied cash at all.
    expect(listed.rowsTotal).toBe(2);
    expect(listed.totalUnapplied).toBeCloseTo(500.01, 2);
    expect(basis.rows).toHaveLength(2);
    expect(basis.rows.reduce((s, r) => s + r.unappliedAmount, 0)).toBeCloseTo(500.01, 2);

    // ...and the reconciler explains exactly that much, because this cash IS on
    // the control account. Where it is not, the item is the control-side figure
    // and the gap is named in excludedRows instead of being folded in.
    const rec = await reconcileSubledger(COMPANY, 'ap', AS_AT);
    const item = rec.reconcilingItems.find((i) => i.type === 'unapplied_receipt');
    expect(item?.documentIds).toHaveLength(2);
    expect(item?.amount).toBeCloseTo(500.01, 2);
    expect(rec.excludedRows.some((e) => e.reason === 'unapplied_cash_off_control_account')).toBe(false);
  }, 120000);

  it('list_unapplied_receipts and the reconciler count the same cash, on AR too', async () => {
    const listed = await getUnappliedReceipts(COMPANY, { asAt: AS_AT, limit: 200 });
    const basis = await getUnappliedPaymentBasis(COMPANY, 'ar', AS_AT);

    // R300 wholly unapplied and R0.01 left on the R100 receipt.
    expect(listed.rowsTotal).toBe(2);
    expect(listed.totalUnapplied).toBeCloseTo(300.01, 2);
    expect(basis.rows).toHaveLength(2);

    const rec = await reconcileSubledger(COMPANY, 'ar', AS_AT);
    const item = rec.reconcilingItems.find((i) => i.type === 'unapplied_receipt');
    expect(item?.amount).toBeCloseTo(300.01, 2);
    expect(rec.unexplainedDifference).toBe(0);
    for (const inv of rec.invariants) {
      expect(inv, `${inv.name}: ${inv.detail}`).toMatchObject({ holds: true });
    }
  }, 120000);

  it('a VOIDED payment leaves no item on either leg', async () => {
    // The reversal used to be reported as posting_with_no_document for the
    // payment's full value while its original stayed silent, because the
    // cancelled payment still claimed it: an unbalanced item on a pair that
    // moved the control account by nothing. On the production copy that was
    // R13,715,088.59 across 322 cancelled payments.
    const rec = await reconcileSubledger(COMPANY, 'ap', AS_AT);
    const orphan = rec.reconcilingItems.find((i) => i.type === 'posting_with_no_document');
    expect(orphan).toBeUndefined();
    // The bill is open again and fully represented on the control account, so
    // it names no item either.
    expect(rec.reconcilingItems.some((i) => i.documentIds.includes(voidedBill))).toBe(false);
  }, 120000);

  it('a CANCELLED credit note does not relieve the bill it points at', async () => {
    // The credit-note leg counted every note linked to the bill whatever its
    // status, so a cancelled note debited the bill's control amount while its
    // reversal was reported separately. On the production copy 22 bills carried
    // R878,993.57 of this against documents worth R390,110.35 — the item
    // claimed more than the documents it named were worth, and the
    // item_within_cited_gross invariant said so.
    const rec = await reconcileSubledger(COMPANY, 'ap', AS_AT);
    expect(rec.reconcilingItems.some((i) => i.documentIds.includes(notedBill))).toBe(false);
    for (const inv of rec.invariants) {
      expect(inv, `${inv.name}: ${inv.detail}`).toMatchObject({ holds: true });
    }
    expect(rec.unexplainedDifference).toBe(0);
  }, 120000);

  it('counts an unconsumed linked credit note ONCE, not against the bill as well', async () => {
    const rec = await reconcileSubledger(COMPANY, 'ap', AS_AT);
    // The bill is exactly represented: its own journal less the APPLIED note.
    expect(rec.reconcilingItems.some((i) => i.documentIds.includes(doubleNotedBill))).toBe(false);
    // The unconsumed note is credit on the control account no document took up,
    // and it is reported there and only there.
    const credit = rec.reconcilingItems.find((i) => i.type === 'unapplied_credit_note');
    expect(credit!.documentNumbers).toContain(TAG + '-CNB');
    expect(credit!.documentNumbers).not.toContain(TAG + '-CNA');
    expect(rec.unexplainedDifference).toBe(0);
  }, 120000);

  it('names the supplier credit note the AP subledger cannot see', async () => {
    // getAPSubledger reads supplier invoices and nothing else, so this note's
    // journal moved the AP control account while subledgerTotal never heard of
    // it — R230 that used to land in unexplained_difference with no name on it.
    const rec = await reconcileSubledger(COMPANY, 'ap', AS_AT);
    const item = rec.reconcilingItems.find((i) => i.type === 'unapplied_credit_note');
    expect(item).toBeDefined();
    expect(item!.documentNumbers).toContain(TAG + '-SCN');
    // The cancelled note is credit that was reversed, so it is not unapplied
    // credit and must not be in here.
    expect(item!.documentNumbers).not.toContain(TAG + '-CCN');
    expect(rec.unexplainedDifference).toBe(0);
  }, 120000);
});
