/**
 * Settled-document evidence for a bank line, as SQL: the documents filed against every bill, invoice and offsetting
 * credit note the line's payment settles. READ-ONLY evidence for display and audit; nothing is copied onto the line.
 *
 * Path: bank line `bt` → its OWN bank leg (gated on `gl_account_id = bt.bank_account_id`: a hand match can name any
 * journal line) whose journal is POSTED → the payment that journal belongs to:
 *  - the leg is `matched_journal_line_id`, and a supplier / customer payment's `gl_journal_entry_id` is its journal
 *    (bank allocation with or without a named bill, FIFO auto-application, split, a payment processed / confirmed
 *    from its screen), or
 *  - the leg is `matched_journal_line_id`, and a PROCESSED supplier payment BATCH carries its journal
 *    (`supplier_payment_batches.gl_journal_entry_id`; a batch posts one journal, its member payments carry none), or
 *  - a bank-first provisional line (`provisional_je_id`): the leg is the provisional journal's bank
 *    line, and the supplier payment that settled it names it (`settles_provisional_je_id`, R-127; that payment's own
 *    journal is the reclass, which has no bank leg);
 * → its allocation rows (`payment_allocations` / `customer_payment_allocations`) → the bill / invoice (not cancelled)
 * → that entity's documents: the entity store, filed directly or cross-linked except PO/GRN paperwork, and a usable
 * source captured document (core/documentPresenceSql's definition). Credit notes applied to a settled bill / invoice
 * (`credit_note_allocations`, not draft or cancelled) are listed too, so a part-cash, part-credit settlement shows them.
 *
 * Gates: the line is in a settling status (`allocated`, `matched`, `reconciled`) and moves money the payment's way
 * (a supplier payment pays OUT, a customer receipt comes IN); the payment is live (supplier `processed` / `reconciled`,
 * customer `confirmed` / `reconciled`) and positive (a refund is not a settlement of the bill it is allocated to).
 * `outstanding` is the bill's total less the larger of (its live allocations + applied credit notes) and its own
 * `amount_paid` (a settlement recorded outside allocations, e.g. an import, still settles it). Known limit: an
 * `amount_paid` left stale-high by data drift hides "still open" (display only; evidence and counts are unaffected).
 * NOT covered: a gateway receipt (journalled to the gateway's clearing account, so the payout line never reaches it).
 *
 * NOT a supporting document of the line itself: bank/bankLineDocumentSql.hasBankLineDocumentSql (the VAT input
 * support report, the line's own paperclip predicate) does not read this module, and must not. The bill already
 * carries its own VAT evidence; settled evidence never clears an input-VAT flag on any other journal.
 *
 * Aliases are fixed code constants, never input, so these are safe for sql.unsafe. Tenant scope: every company-owned
 * table is joined on the line's company; the allocation tables, procurement_documents and document_links carry no
 * company_id and are reached only through a payment / entity already fenced to it.
 */
import { ORDER_PAPERWORK_LINK_REASONS, hasEntityDocumentSql } from '../core/documentPresenceSql';
import { capturedDocUsableSql } from './bankLineDocumentSql';
import { SETTLING_LINE_STATUSES } from '../core/paymentVoidReads';

/** One line settles a bounded set of bills; the list stops here and the count is capped to match. */
export const SETTLED_DOCUMENTS_MAX = 200;

type Alias = 'bt';
const list = (values: readonly string[]): string => values.map((v) => `'${v}'`).join(', ');

interface Source {
  /** Which journal line of `bt` is its bank leg `bl` (the bank-account gate is added for every source). */
  leg: (bt: Alias) => string;
  /** Joins from the bank leg `bl` (and its posted journal) to the payment `p`, fenced to `bt`'s company. */
  payment: (bt: Alias) => string;
  payments: string; allocations: string; invoices: string; inv: 'si' | 'ci';
  invoiceType: 'supplier_invoice' | 'customer_invoice'; creditType: 'supplier' | 'customer';
  paymentKind: 'supplier_payment' | 'customer_payment'; liveStatuses: readonly string[]; direction: '<' | '>';
}

const SUPPLIER = {
  payments: 'supplier_payments', allocations: 'payment_allocations', invoices: 'supplier_invoices', inv: 'si',
  invoiceType: 'supplier_invoice', creditType: 'supplier', paymentKind: 'supplier_payment',
  liveStatuses: ['processed', 'reconciled'], direction: '<',
} as const;

const MATCHED_LEG = (bt: Alias): string => `bl.id = ${bt}.matched_journal_line_id`;

const SOURCES: readonly Source[] = [
  { ...SUPPLIER, leg: MATCHED_LEG, payment: (bt) => ` JOIN supplier_payments p ON p.gl_journal_entry_id = bl.journal_entry_id`
    + ` AND p.company_id = ${bt}.company_id` },
  { ...SUPPLIER, leg: MATCHED_LEG,
    payment: (bt) => ` JOIN supplier_payment_batches sb ON sb.gl_journal_entry_id = bl.journal_entry_id`
      + ` AND sb.company_id = ${bt}.company_id AND sb.status = 'processed'`
      + ` JOIN supplier_payments p ON p.batch_id = sb.id AND p.company_id = ${bt}.company_id` },
  { ...SUPPLIER,
    // No matched-line condition: should a provisional line ever also be matched (to its own provisional leg), it keeps
    // its evidence; the other sources cannot reach this payment (it carries the reclass journal), so nothing doubles.
    leg: (bt) => `bl.journal_entry_id = ${bt}.provisional_je_id`,
    payment: (bt) => ` JOIN supplier_payments p ON p.settles_provisional_je_id = bl.journal_entry_id`
      + ` AND p.company_id = ${bt}.company_id` },
  { payments: 'customer_payments', allocations: 'customer_payment_allocations', invoices: 'customer_invoices', inv: 'ci',
    invoiceType: 'customer_invoice', creditType: 'customer', paymentKind: 'customer_payment',
    liveStatuses: ['confirmed', 'reconciled'], direction: '>', leg: MATCHED_LEG,
    payment: (bt) => ` JOIN customer_payments p ON p.gl_journal_entry_id = bl.journal_entry_id`
      + ` AND p.company_id = ${bt}.company_id` },
];

/**
 * The joins and the WHERE of one settlement chain, correlated to the bank line `bt`: bank leg `bl`, posted journal,
 * payment `p`, allocation `a`, invoice `s.inv`, plus `joins`. The caller writes FROM … in front.
 */
function chain(s: Source, bt: Alias, joins = ''): { from: string; where: string } {
  return {
    from: `gl_journal_lines bl`
      + ` JOIN gl_journal_entries je ON je.id = bl.journal_entry_id AND je.company_id = ${bt}.company_id`
      + ` AND je.status = 'posted'`
      + s.payment(bt)
      + ` JOIN ${s.allocations} a ON a.payment_id = p.id`
      + ` JOIN ${s.invoices} ${s.inv} ON ${s.inv}.id = a.invoice_id AND ${s.inv}.company_id = ${bt}.company_id`
      + ` AND ${s.inv}.status IS DISTINCT FROM 'cancelled'`
      + joins,
    where: `${s.leg(bt)} AND bl.gl_account_id = ${bt}.bank_account_id`
      + ` AND bl.company_id = ${bt}.company_id AND ${bt}.status IN (${list(SETTLING_LINE_STATUSES)})`
      + ` AND ${bt}.amount ${s.direction} 0`
      + ` AND p.status IN (${list(s.liveStatuses)}) AND p.total_amount > 0`,
  };
}

/**
 * What the invoice aliased `s.inv` still has outstanding: its total less the LARGER of (every live allocation +
 * applied credit note) and its own `amount_paid` (a settlement recorded outside allocations still settles it).
 */
function outstandingSql(s: Source): string {
  const inv = s.inv;
  return `(${inv}.total_amount - GREATEST(COALESCE(${inv}.amount_paid, 0),`
    + ` COALESCE((SELECT SUM(a2.amount_allocated) FROM ${s.allocations} a2 JOIN ${s.payments} p2 ON p2.id = a2.payment_id`
    + ` AND p2.company_id = ${inv}.company_id AND p2.status IN (${list(s.liveStatuses)}) AND p2.total_amount > 0`
    + ` WHERE a2.invoice_id = ${inv}.id), 0)`
    + ` + COALESCE((SELECT SUM(c2.amount_allocated) FROM credit_note_allocations c2 JOIN credit_notes n2`
    + ` ON n2.id = c2.credit_note_id AND n2.company_id = ${inv}.company_id AND n2.type = '${s.creditType}'`
    + ` AND n2.status NOT IN ('draft', 'cancelled')`
    + ` WHERE c2.invoice_id = ${inv}.id AND c2.company_id = ${inv}.company_id), 0)))`;
}

/**
 * Rows: every entity bank line `bt` settles — the bills / invoices its payment applied to, and the credit notes applied
 * to those — with the payment and the amounts. Columns: entity_type, entity_id, entity_number, entity_total, applied
 * (by this payment; a credit note: the credit it applied), outstanding (a bill / invoice after every live payment and
 * credit; NULL for a credit note and unless `withOutstanding`), settles_invoice_id, settles_number, payment_kind,
 * payment_id, payment_number, source_document_id, company_id.
 */
export function settledEntitiesSql(bt: Alias = 'bt', withOutstanding = false): string {
  return SOURCES.map((s) => {
    const inv = s.inv;
    const credit = ` JOIN credit_note_allocations cna ON cna.invoice_id = ${inv}.id AND cna.company_id = ${bt}.company_id`
      + ` JOIN credit_notes cn ON cn.id = cna.credit_note_id AND cn.company_id = ${bt}.company_id`
      + ` AND cn.type = '${s.creditType}' AND cn.status NOT IN ('draft', 'cancelled')`;
    const own = chain(s, bt);
    const cnChain = chain(s, bt, credit);
    return `SELECT '${s.invoiceType}'::text AS entity_type, ${inv}.id AS entity_id, ${inv}.invoice_number::text AS entity_number,`
      + ` ${inv}.total_amount AS entity_total, a.amount_allocated AS applied,`
      + ` ${withOutstanding ? outstandingSql(s) : 'NULL::numeric'} AS outstanding, ${inv}.id AS settles_invoice_id,`
      + ` ${inv}.invoice_number::text AS settles_number, '${s.paymentKind}'::text AS payment_kind, p.id AS payment_id,`
      + ` p.payment_number::text AS payment_number, ${inv}.source_document_id, ${inv}.company_id`
      + ` FROM ${own.from} WHERE ${own.where}`
      + ` UNION ALL SELECT 'credit_note'::text, cn.id, cn.credit_note_number::text, cn.total_amount, cna.amount_allocated,`
      + ` NULL::numeric, ${inv}.id, ${inv}.invoice_number::text, '${s.paymentKind}'::text, p.id, p.payment_number::text,`
      + ` NULL::uuid, cn.company_id FROM ${cnChain.from} WHERE ${cnChain.where}`;
  }).join(' UNION ALL ');
}

/**
 * Rows: the documents of every entity bank line `bt` settles, one row per (document, settled entity, payment). store
 * 'entity' is a procurement_documents row (filed directly, or cross-linked except PO/GRN paperwork); 'captured' is the
 * bill's / invoice's usable source captured document (its mime_type column carries the captured file_type), unless it
 * is already linked to this line (then it is one of the line's OWN documents and must not be counted twice).
 */
export function settledDocumentsSql(bt: Alias = 'bt', withOutstanding = false): string {
  return `SELECT DISTINCT d.store, d.document_id, d.file_name, d.mime_type, d.file_size, d.file_url, d.created_at,`
    + ` se.entity_type, se.entity_id, se.entity_number, se.entity_total, se.applied, se.outstanding,`
    + ` se.settles_invoice_id, se.settles_number, se.payment_kind, se.payment_id, se.payment_number`
    + ` FROM (${settledEntitiesSql(bt, withOutstanding)}) se CROSS JOIN LATERAL (`
    + `SELECT 'entity'::text AS store, pd.id AS document_id, pd.document_name::text AS file_name,`
    + ` pd.mime_type::text AS mime_type, pd.file_size, pd.file_url, pd.uploaded_at AS created_at`
    + ` FROM procurement_documents pd WHERE pd.entity_type = se.entity_type AND pd.entity_id = se.entity_id`
    + ` AND pd.is_active = true`
    + ` UNION ALL SELECT 'entity'::text, pd.id, pd.document_name::text, pd.mime_type::text, pd.file_size, pd.file_url,`
    + ` pd.uploaded_at FROM document_links dl JOIN procurement_documents pd ON pd.id = dl.document_id AND pd.is_active = true`
    + ` WHERE dl.linked_entity_type = se.entity_type AND dl.linked_entity_id = se.entity_id`
    + ` AND COALESCE(dl.link_reason, '') NOT IN (${list(ORDER_PAPERWORK_LINK_REASONS)})`
    + ` UNION ALL SELECT 'captured'::text, scd.id, scd.file_name, scd.file_type, COALESCE(scd.raw_bytes_size, scd.file_size),`
    + ` NULL::text, scd.created_at FROM captured_documents scd WHERE scd.id = se.source_document_id`
    + ` AND scd.company_id = se.company_id AND NULLIF(scd.storage_path, '') IS NOT NULL AND ${capturedDocUsableSql('scd')}`
    + ` AND scd.matched_bank_tx_id IS DISTINCT FROM ${bt}.id`
    + `) d`;
}

/** Scalar: the number of rows the line's settled list shows (same grain, same cap) — the paperclip's second part. */
export function settledDocumentCountSql(bt: Alias = 'bt'): string {
  return `(SELECT LEAST(COUNT(*), ${SETTLED_DOCUMENTS_MAX}) FROM (${settledDocumentsSql(bt)}) sd)`;
}

/**
 * Boolean: bank line `bt` settles at least one bill / invoice that has a supporting document (documentPresenceSql's
 * definition). A credit note's document alone does not count (it lights the paperclip, not the evidence): the bill
 * the cash paid is the evidence.
 */
export function hasSettledDocumentSql(bt: Alias = 'bt'): string {
  return '(' + SOURCES.map((s) => {
    const c = chain(s, bt);
    return `EXISTS (SELECT 1 FROM ${c.from} WHERE ${c.where} AND ${hasEntityDocumentSql(s.invoiceType, s.inv)})`;
  }).join(' OR ') + ')';
}

/**
 * Boolean: the captured document aliased `scd` is the usable source document of a bill / invoice one of its company's
 * bank lines settles — the same chain and gates as the list, from the document outwards. The captured-document-file
 * route serves those bytes on that ground.
 */
export function isSettledSourceCaptureSql(scd: 'scd' = 'scd'): string {
  const chains = SOURCES.map((s) => {
    const c = chain(s, 'bt');
    return `EXISTS (SELECT 1 FROM bank_transactions bt CROSS JOIN ${c.from} WHERE ${c.where}`
      + ` AND bt.company_id = ${scd}.company_id AND ${s.inv}.source_document_id = ${scd}.id)`;
  });
  return `(NULLIF(${scd}.storage_path, '') IS NOT NULL AND ${capturedDocUsableSql(scd)} AND (${chains.join(' OR ')}))`;
}
