/**
 * WHERE A JOURNAL'S AMOUNT CAME FROM, PER SOURCE — for the round-number test.
 *
 * A round number is suspicious where someone keyed it in: a hand-entered
 * R50 000 tends to be an estimate standing in for an actual. A posting the
 * system generated from a document — an invoice, a payment, a bank line, a
 * payroll run — carries the document's amount, and on Velocity Fibre's
 * production copy those made 688 of its 693 round-number flags.
 *
 * NOT A PREFIX RULE. `auto_` also covers amounts a person or an agent types:
 * recurring templates, GL imports, VAT adjustments, opening balances,
 * write-offs and adjustments. Classified one source at a time, and typed as
 * `Record<GLEntrySource, …>`, so a source added to `GL_ENTRY_SOURCES` does not
 * compile until someone decides which it is. An unknown source is 'entered'.
 *
 * 'entered' also covers an expense claim (the employee types the amount it
 * pays them; a receipt is optional), disposal proceeds, and three sources no
 * code writes yet (`auto_grn`, `auto_purchase_order`, `auto_loan_payment`): a
 * future writer of typed amounts is tested until someone decides otherwise.
 */
import type { GLEntrySource } from '@/modules/accounting/types/gl.types';

export type JournalSourceKind = 'document' | 'entered';

export const JOURNAL_SOURCE_KINDS: Record<GLEntrySource, JournalSourceKind> = {
  manual: 'entered',
  auto_invoice: 'document',
  auto_payment: 'document',
  auto_grn: 'entered',
  auto_credit_note: 'document',
  auto_bank_recon: 'document',
  auto_supplier_invoice: 'document',
  auto_supplier_payment: 'document',
  auto_write_off: 'entered',
  auto_adjustment: 'entered',
  auto_vat_adjustment: 'entered',
  auto_vat_submission: 'document', // computed from the VAT return
  auto_batch_payment: 'document',
  auto_recurring: 'entered',
  auto_purchase_order: 'entered',
  auto_depreciation: 'document', // computed from the asset register
  auto_payroll: 'document', // computed by the pay run
  auto_migration: 'entered',
  auto_loan_payment: 'entered',
  auto_expense_claim: 'entered',
  auto_expense_receipt: 'document',
  auto_bank_transfer: 'document', // the bank line's amount (bankAllocationService)
  auto_asset_disposal: 'entered',
  auto_asset_expense: 'document', // under the capitalisation threshold, so under the R10 000 floor
  auto_gl_import: 'entered',
  year_end: 'document', // computed: the closing of the period's balances
  auto_vat_late_claim: 'document',
};

export const DOCUMENT_POSTING_SOURCES: ReadonlySet<string> = new Set(
  Object.entries(JOURNAL_SOURCE_KINDS).filter(([, kind]) => kind === 'document').map(([source]) => source),
);

/** True only for a known source generated from a document; anything else —
 *  unknown, missing — is treated as keyed in, and tested. */
export function isDocumentPosting(source: unknown): boolean {
  return typeof source === 'string' && DOCUMENT_POSTING_SOURCES.has(source);
}
