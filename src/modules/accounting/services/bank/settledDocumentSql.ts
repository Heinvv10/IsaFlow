/**
 * Settled-document evidence for a bank line, as SQL: the documents filed against every bill, invoice and offsetting
 * credit note the line's payment settles. READ-ONLY evidence for display and audit; nothing is copied onto the line.
 *
 * Path: bank line `bt` → its OWN bank leg (`matched_journal_line_id`, gated on `gl_account_id = bt.bank_account_id`:
 * a hand match can name any journal line, see feedback-matched-journal-line-not-bank-leg) → the supplier / customer
 * payment carrying that journal (`gl_journal_entry_id`; the bank-allocation path, the FIFO auto-application and the
 * bill-naming path all write it) → its allocation rows (`payment_allocations` / `customer_payment_allocations`) → the
 * bill / invoice → that entity's documents (the entity store, directly or cross-linked except PO/GRN paperwork, and a
 * usable source captured document: core/documentPresenceSql's definition). Credit notes applied to a settled bill or
 * invoice (`credit_note_allocations`) are listed too, so a part-cash, part-credit settlement shows its credit note.
 *
 * Only a line in a settling status (`allocated`, `matched`, `reconciled`) and a payment that is not cancelled count.
 *
 * NOT a supporting document of the line itself: bank/bankLineDocumentSql.hasBankLineDocumentSql (the VAT input
 * support report, the line's own paperclip predicate) does not read this module, and must not. The bill already
 * carries its own VAT evidence; settled evidence never clears an input-VAT block on any other journal.
 *
 * Aliases are fixed code constants, never input, so these are safe for sql.unsafe. Every join re-checks company_id
 * against the line's own company.
 */
import { ORDER_PAPERWORK_LINK_REASONS, hasEntityDocumentSql } from '../core/documentPresenceSql';
import { capturedDocUsableSql } from './bankLineDocumentSql';
import { SETTLING_LINE_STATUSES } from '../core/paymentVoidReads';

type Alias = 'bt';
const list = (values: readonly string[]): string => values.map((v) => `'${v}'`).join(', ');

/** The bank line's own bank leg journal, as a correlated condition on `bl`. */
function bankLegSql(bt: Alias): string {
  return `bl.id = ${bt}.matched_journal_line_id AND bl.gl_account_id = ${bt}.bank_account_id`
    + ` AND bl.company_id = ${bt}.company_id AND ${bt}.status IN (${list(SETTLING_LINE_STATUSES)})`;
}

interface Side {
  payments: string; allocations: string; invoices: string; invoiceType: 'supplier_invoice' | 'customer_invoice';
  creditType: 'supplier' | 'customer'; paymentKind: 'supplier_payment' | 'customer_payment'; inv: 'si' | 'ci';
}
const SIDES: readonly Side[] = [
  { payments: 'supplier_payments', allocations: 'payment_allocations', invoices: 'supplier_invoices',
    invoiceType: 'supplier_invoice', creditType: 'supplier', paymentKind: 'supplier_payment', inv: 'si' },
  { payments: 'customer_payments', allocations: 'customer_payment_allocations', invoices: 'customer_invoices',
    invoiceType: 'customer_invoice', creditType: 'customer', paymentKind: 'customer_payment', inv: 'ci' },
];

/** FROM … WHERE for one side: payment p, allocation a, invoice `s.inv` of bank line `bt`, plus `joins`. */
function settledInvoiceJoinSql(s: Side, bt: Alias, joins = ''): string {
  return `FROM gl_journal_lines bl`
    + ` JOIN ${s.payments} p ON p.gl_journal_entry_id = bl.journal_entry_id AND p.company_id = ${bt}.company_id`
    + ` AND p.status <> 'cancelled'`
    + ` JOIN ${s.allocations} a ON a.payment_id = p.id`
    + ` JOIN ${s.invoices} ${s.inv} ON ${s.inv}.id = a.invoice_id AND ${s.inv}.company_id = ${bt}.company_id`
    + joins
    + ` WHERE ${bankLegSql(bt)}`;
}

/**
 * Rows: every entity bank line `bt` settles — the bills / invoices its payment applied to, and the credit notes applied
 * to those — with the payment it went through and the amounts. Columns: entity_type, entity_id, entity_number,
 * entity_total, applied (by this payment; for a credit note, the credit it applied to the invoice), settles_invoice_id,
 * payment_kind, payment_id, payment_number, source_document_id, company_id.
 */
export function settledEntitiesSql(bt: Alias = 'bt'): string {
  return SIDES.map((s) => {
    const inv = s.inv;
    const creditJoins = ` JOIN credit_note_allocations cna ON cna.invoice_id = ${inv}.id AND cna.company_id = ${bt}.company_id`
      + ` JOIN credit_notes cn ON cn.id = cna.credit_note_id AND cn.company_id = ${bt}.company_id`
      + ` AND cn.type = '${s.creditType}' AND cn.status NOT IN ('draft', 'cancelled')`;
    return `SELECT '${s.invoiceType}'::text AS entity_type, ${inv}.id AS entity_id, ${inv}.invoice_number::text AS entity_number,`
      + ` ${inv}.total_amount AS entity_total, a.amount_allocated AS applied, ${inv}.id AS settles_invoice_id,`
      + ` ${inv}.invoice_number::text AS settles_number, '${s.paymentKind}'::text AS payment_kind, p.id AS payment_id,`
      + ` p.payment_number::text AS payment_number, ${inv}.source_document_id, ${inv}.company_id`
      + ` ${settledInvoiceJoinSql(s, bt)}`
      + ` UNION ALL SELECT 'credit_note'::text, cn.id, cn.credit_note_number::text, cn.total_amount, cna.amount_allocated,`
      + ` ${inv}.id, ${inv}.invoice_number::text, '${s.paymentKind}'::text, p.id, p.payment_number::text, NULL::uuid,`
      + ` cn.company_id ${settledInvoiceJoinSql(s, bt, creditJoins)}`;
  }).join(' UNION ALL ');
}

/**
 * Rows: the documents of every entity bank line `bt` settles (settledEntitiesSql `se`). store 'entity' is a
 * procurement_documents row (direct, or cross-linked except PO/GRN paperwork); 'captured' is the bill's / invoice's
 * usable source captured document (its mime_type column carries the captured file_type). One row per
 * (document, settled entity, payment).
 */
export function settledDocumentsSql(bt: Alias = 'bt'): string {
  const docCols = 'se.entity_type, se.entity_id, se.entity_number, se.entity_total, se.applied, se.settles_invoice_id,'
    + ' se.settles_number, se.payment_kind, se.payment_id, se.payment_number';
  return `SELECT 'entity'::text AS store, pd.id AS document_id, pd.document_name::text AS file_name,`
    + ` pd.mime_type::text AS mime_type, pd.file_size, pd.file_url, pd.uploaded_at AS created_at, ${docCols}`
    + ` FROM (${settledEntitiesSql(bt)}) se`
    + ` JOIN procurement_documents pd ON pd.is_active = true AND (`
    + `(pd.entity_type = se.entity_type AND pd.entity_id = se.entity_id)`
    + ` OR pd.id IN (SELECT dl.document_id FROM document_links dl WHERE dl.linked_entity_type = se.entity_type`
    + ` AND dl.linked_entity_id = se.entity_id AND COALESCE(dl.link_reason, '') NOT IN (${list(ORDER_PAPERWORK_LINK_REASONS)})))`
    + ` UNION ALL`
    + ` SELECT 'captured'::text, scd.id, scd.file_name, scd.file_type, COALESCE(scd.raw_bytes_size, scd.file_size),`
    + ` NULL::text, scd.created_at, ${docCols}`
    + ` FROM (${settledEntitiesSql(bt)}) se`
    + ` JOIN captured_documents scd ON scd.id = se.source_document_id AND scd.company_id = se.company_id`
    + ` AND NULLIF(scd.storage_path, '') IS NOT NULL AND ${capturedDocUsableSql('scd')}`;
}

/** Scalar: how many distinct documents bank line `bt` shows from what it settles (the paperclip's second part). */
export function settledDocumentCountSql(bt: Alias = 'bt'): string {
  return `(SELECT COUNT(DISTINCT sd.document_id) FROM (${settledDocumentsSql(bt)}) sd)`;
}

/**
 * Boolean: bank line `bt` settles at least one bill / invoice that has a supporting document (documentPresenceSql's
 * definition). A credit note's document alone does not count: the bill the cash paid is the evidence.
 */
export function hasSettledDocumentSql(bt: Alias = 'bt'): string {
  return '(' + SIDES.map((s) => `EXISTS (SELECT 1 ${settledInvoiceJoinSql(s, bt)}`
    + ` AND ${hasEntityDocumentSql(s.invoiceType, s.inv)})`).join(' OR ') + ')';
}
