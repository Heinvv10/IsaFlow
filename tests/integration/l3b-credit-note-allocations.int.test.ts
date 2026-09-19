/**
 * L3b — the reconciler attributes a credit note by its ALLOCATION ROWS.
 *
 * WHAT THIS PINS. `unpostedDocumentQueries` relieved a document by
 * `SUM(credit_notes.applied_amount)` joined through the single link column.
 * Since migration 677 a note is applied FIFO across several documents and the
 * per-document truth is in `credit_note_allocations`, so that read attributed a
 * split note WHOLLY to the bill it links to and left every other bill it
 * settled looking unrelieved. On a production copy `reconcile_subledger(ap)`
 * reported `document_not_on_control_account` of -R3,728,724.75 over 150
 * documents against an `unexplained_difference` of +R3,728,724.79 — offsetting
 * to the cent, internally consistent, and not a fact about the books.
 *
 * THREE SHAPES, because the fix has three arms: the rows, the pre-677 note that
 * has none, and the cancelled note that must relieve nothing at all.
 *
 * A SUPPLIER PER SCENARIO, deliberately. The FIFO walk settles the linked
 * document and then the SAME ENTITY's other open documents oldest first, so one
 * shared supplier would let the split note's remainder wander into the legacy
 * and cancelled fixtures and each case would stop testing what it names.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { sql, getPoolForTests } from '@/lib/neon';
import { postSupplierInvoiceToGL } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteApproveService';
import { cancelCreditNote } from '@/modules/accounting/services/ar/creditNoteCancelService';
import { reconcileSubledger } from '@/modules/accounting/services/reconciliation/subledgerReconciliationService';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();
const TAG = `L3B${Math.floor(Math.random() * 1e8)}`;

const DOC_DATE = '2026-03-01';
const LATER_DATE = '2026-03-05';
const SETTLE_DATE = '2026-03-15';
const AS_AT = '2026-06-30';
const SUB = 1000;
const VAT = 150;
const GROSS = SUB + VAT;

let supplierSplit = '';
let supplierLegacy = '';
let supplierCancel = '';
let supplierUnlinked = '';
let expense = '';
let splitLinked = '';
let splitWalked = '';
let legacyBill = '';
let cancelledBill = '';
let splitNote = '';
let unlinkedBill = '';

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

async function supplier(name: string): Promise<string> {
  return ((await sql`INSERT INTO suppliers (company_id, name)
    VALUES (${COMPANY}::UUID, ${name + ' ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;
}

/** An approved bill, posted to the GL through the real workflow. */
async function bill(n: string, supplierId: string, date: string): Promise<string> {
  const id = ((await sql`
    INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date,
      status, subtotal, tax_amount, total_amount, amount_paid, created_by)
    VALUES (${COMPANY}::UUID, ${supplierId}::UUID, ${TAG + n}, ${date}::date, ${date}::date,
      'approved', ${SUB}, ${VAT}, ${GROSS}, 0, ${USER}::UUID)
    RETURNING id`) as { id: string }[])[0]!.id;
  await sql`
    INSERT INTO supplier_invoice_items (supplier_invoice_id, description, quantity, unit_price,
      tax_rate, tax_amount, line_total, gl_account_id)
    VALUES (${id}::UUID, 'L3b line', 1, ${SUB}, 15, ${VAT}, ${SUB}, ${expense}::UUID)`;
  await inTx(() => postSupplierInvoiceToGL(COMPANY, id, USER));
  return id;
}

/** A draft supplier credit note linked to a bill, for the caller to approve. */
async function note(n: string, supplierId: string, invoiceId: string, total: number): Promise<string> {
  const tax = Math.round((total / 1.15) * 0.15 * 100) / 100;
  return ((await sql`
    INSERT INTO credit_notes (company_id, type, supplier_id, supplier_invoice_id,
      credit_note_number, credit_date, subtotal, tax_amount, total_amount, status,
      applied_amount, created_by)
    VALUES (${COMPANY}::UUID, 'supplier', ${supplierId}::UUID, ${invoiceId}::UUID,
      ${TAG + n}, ${SETTLE_DATE}::date, ${total - tax}, ${tax}, ${total}, 'draft', 0, ${USER}::UUID)
    RETURNING id`) as { id: string }[])[0]!.id;
}

describeIfDb('L3b — a credit note relieves the documents its allocation rows name', () => {
  beforeAll(async () => {
    await sql`INSERT INTO companies (id, name, registration_number)
              VALUES (${COMPANY}::UUID, ${'L3b ' + TAG}, ${TAG})`;
    await sql`INSERT INTO users (id, email, role, is_active)
              VALUES (${USER}, ${USER + '@test.local'}, 'admin', true)`;
    await sql`INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year,
                start_date, end_date, status)
              VALUES (${COMPANY}::UUID, ${'L3b ' + TAG}, 1, 2026, '2026-01-01', '2026-12-31', 'open')`;

    await account('2110', 'Trade Creditors', 'liability', 'credit', 'payable');
    await account('1000', 'Bank', 'asset', 'debit', 'bank');
    expense = await account('5000', 'Materials', 'expense', 'debit', 'default_expense');
    await account('1300', 'VAT Input', 'asset', 'debit', 'vat_input');
    await account('2200', 'VAT Output', 'liability', 'credit', 'vat_output');
    await account('1120', 'Trade Debtors', 'asset', 'debit', 'receivable');
    await account('4000', 'Sales', 'revenue', 'credit', 'default_revenue');

    supplierSplit = await supplier('split');
    supplierLegacy = await supplier('legacy');
    supplierCancel = await supplier('cancel');
    supplierUnlinked = await supplier('unlinked');

    // ── ONE NOTE, TWO BILLS. The note names the first and is worth both, so
    // the FIFO walk carries its remainder to the second. Before the fix the
    // whole 2,300 was charged to the linked bill and the walked one was
    // reported as absent from the control account.
    splitLinked = await bill('-SPLIT-A', supplierSplit, DOC_DATE);
    splitWalked = await bill('-SPLIT-B', supplierSplit, LATER_DATE);
    splitNote = await note('-SPLIT-CN', supplierSplit, splitLinked, GROSS * 2);
    await inTx(() => approveCreditNote(COMPANY, splitNote, USER));

    // ── NO LINK AT ALL, settled by the walk alone. This is the shape that
    // does not cancel itself out: the old read attributed the note to the one
    // document its link column named, and with no link it attributed it to
    // NOTHING, so the bill it really settled stood alone as absent from the
    // control account and the same value became an unnamed residual.
    unlinkedBill = await bill('-UNLINKED', supplierUnlinked, DOC_DATE);
    const unlinkedNote = ((await sql`
      INSERT INTO credit_notes (company_id, type, supplier_id, credit_note_number, credit_date,
        subtotal, tax_amount, total_amount, status, applied_amount, created_by)
      VALUES (${COMPANY}::UUID, 'supplier', ${supplierUnlinked}::UUID, ${TAG + '-UNLINKED-CN'},
        ${SETTLE_DATE}::date, ${SUB}, ${VAT}, ${GROSS}, 'draft', 0, ${USER}::UUID)
      RETURNING id`) as { id: string }[])[0]!.id;
    await inTx(() => approveCreditNote(COMPANY, unlinkedNote, USER));

    // ── THE PRE-677 SHAPE: applied_amount set, the link column naming the one
    // document it credited, and NO allocation rows — a note the 677 back-fill
    // could not attribute. Approved through the real service and its rows then
    // removed, so every other column is exactly what the service writes.
    legacyBill = await bill('-LEGACY', supplierLegacy, DOC_DATE);
    const legacyNote = await note('-LEGACY-CN', supplierLegacy, legacyBill, GROSS);
    await inTx(() => approveCreditNote(COMPANY, legacyNote, USER));
    await sql`DELETE FROM credit_note_allocations
              WHERE credit_note_id = ${legacyNote}::UUID AND company_id = ${COMPANY}::UUID`;

    // ── CANCELLED: the journal is reversed and the application undone, so the
    // bill is open again and the note has relieved nothing.
    cancelledBill = await bill('-CANCEL', supplierCancel, DOC_DATE);
    const cancelledNote = await note('-CANCEL-CN', supplierCancel, cancelledBill, GROSS);
    await inTx(() => approveCreditNote(COMPANY, cancelledNote, USER));
    await inTx(() => cancelCreditNote(COMPANY, cancelledNote, USER));
  }, 180000);

  afterAll(async () => {
    await sql`DELETE FROM credit_note_allocations WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM credit_notes WHERE company_id = ${COMPANY}::UUID`;
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
    await sql`DELETE FROM users WHERE id = ${USER}`;
    await sql`DELETE FROM companies WHERE id = ${COMPANY}::UUID`;
  }, 120000);

  it('the FIFO approval really did split the note over both bills', async () => {
    // The premise of the case below, asserted rather than assumed: without
    // these rows the reconciler would be reading a shape the fixture never
    // built, and the test would pass for the wrong reason.
    const rows = (await sql`
      SELECT invoice_id, amount_allocated FROM credit_note_allocations
      WHERE credit_note_id = ${splitNote}::UUID AND company_id = ${COMPANY}::UUID
      ORDER BY amount_allocated`) as { invoice_id: string; amount_allocated: string }[];
    expect(rows.map((r) => r.invoice_id).sort()).toEqual([splitLinked, splitWalked].sort());
    expect(rows.reduce((s, r) => s + Number(r.amount_allocated), 0)).toBeCloseTo(GROSS * 2, 2);
  }, 120000);

  it('attributes a split note to each bill by its own row, naming neither as absent', async () => {
    const rec = await reconcileSubledger(COMPANY, 'ap', AS_AT);
    // Both bills are exactly represented: each one's own journal, less the
    // credit its OWN allocation row carries.
    expect(rec.reconcilingItems.some((i) => i.documentIds.includes(splitLinked))).toBe(false);
    expect(rec.reconcilingItems.some((i) => i.documentIds.includes(splitWalked))).toBe(false);
    expect(rec.reconcilingItems.find((i) => i.type === 'document_not_on_control_account')).toBeUndefined();
    // AND not as an EXCLUDED row either. The two mis-attributions are equal and
    // opposite — the linked bill over-relieved by the walked bill's share — so
    // they cancel to the cent and the reconciler drops the pair as
    // `net_zero_reconciling_item`. That is two real findings reported as no
    // item, which is exactly how a split note hid on books that appeared to
    // tie, so the absence of the EXCLUSION is the assertion that bites.
    const excluded = rec.excludedRows.filter((e) => e.reason === 'net_zero_reconciling_item');
    expect(excluded).toEqual([]);
  }, 120000);

  it('attributes a note with NO link at all to the bill the walk settled', async () => {
    // Nothing offsets this one: with no link column to read, the old query
    // relieved the bill by nothing, so its full value stood as
    // document_not_on_control_account and the same value fell into
    // unexplained_difference with no name on it.
    const rec = await reconcileSubledger(COMPANY, 'ap', AS_AT);
    expect(rec.reconcilingItems.some((i) => i.documentIds.includes(unlinkedBill))).toBe(false);
    expect(rec.excludedRows.some((e) => e.detail?.includes(TAG + '-UNLINKED'))).toBe(false);
  }, 120000);

  it('still attributes a pre-677 note through the link column it names', async () => {
    // The NOT EXISTS arm. Dropping it would silently stop relieving every note
    // the back-fill could not attribute, and each would become a fresh
    // document_not_on_control_account item.
    const rec = await reconcileSubledger(COMPANY, 'ap', AS_AT);
    expect(rec.reconcilingItems.some((i) => i.documentIds.includes(legacyBill))).toBe(false);
  }, 120000);

  it('a CANCELLED note relieves nothing, on either arm', async () => {
    // Cancelling reverses the journal and undoes the application, so the bill
    // is open at its full value and fully on the control account. Counting the
    // note anyway makes the bill read as enormously under-represented.
    const rec = await reconcileSubledger(COMPANY, 'ap', AS_AT);
    expect(rec.reconcilingItems.some((i) => i.documentIds.includes(cancelledBill))).toBe(false);
    const open = (await sql`
      SELECT amount_paid FROM supplier_invoices
      WHERE id = ${cancelledBill}::UUID AND company_id = ${COMPANY}::UUID`) as { amount_paid: string }[];
    expect(Number(open[0]!.amount_paid)).toBeCloseTo(0, 2);
  }, 120000);

  it('leaves nothing unexplained, with every invariant holding', async () => {
    const rec = await reconcileSubledger(COMPANY, 'ap', AS_AT);
    expect(rec.unexplainedDifference).toBe(0);
    for (const inv of rec.invariants) {
      expect(inv, `${inv.name}: ${inv.detail}`).toMatchObject({ holds: true });
    }
  }, 120000);
});
