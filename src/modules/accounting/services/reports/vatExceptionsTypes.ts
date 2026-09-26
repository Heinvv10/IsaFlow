/**
 * VAT Exceptions Report — types and row mappers.
 * Query orchestration lives in vatExceptionsService.ts.
 */

export interface UncodedGlVatLine {
  journalEntryId: string;
  entryNumber: string;
  entryDate: string;
  accountCode: string;
  accountName: string;
  subtype: 'vat_input' | 'vat_output';
  description: string;
  amount: number;
}

export interface InvoiceTaxCodeIssue {
  invoiceId: string;
  invoiceKind: 'customer' | 'supplier';
  invoiceNumber: string;
  counterpartyName: string;
  invoiceDate: string;
  subtotal: number;
  taxRate: number | null;
  taxAmount: number;
  issue: 'missing_tax_rate' | 'rate_without_vat';
}

export interface InvoiceGlVatMismatch {
  invoiceId: string;
  invoiceKind: 'customer' | 'supplier';
  invoiceNumber: string;
  counterpartyName: string;
  invoiceDate: string;
  invoiceVat: number;
  glVat: number;
  variance: number;
  /**
   * 'je_not_posted': the linked JE exists but is not posted — the GL side is
   * legitimately 0.00, so the row is a posting gap, not an amount mismatch.
   */
  reason: 'amount_mismatch' | 'je_not_posted';
}

/**
 * A posted line claiming VAT against a balance-sheet account that has no
 * legitimate reason to carry it. The rule, and the exclusions that make it
 * meaningful, live in vatBalanceSheetExceptions.ts.
 */
export interface VatOnBalanceSheetLine {
  journalEntryId: string;
  entryNumber: string;
  entryDate: string;
  accountCode: string;
  accountName: string;
  /** Carried so the reader can see WHY it was flagged, not just that it was. */
  accountType: string;
  accountSubtype: string | null;
  vatType: string;
  description: string;
  amount: number;
}

/**
 * Why an account can never carry VAT. Defined beside the patterns that assign
 * it, in `gl/nonSupplyAccounts`, and re-exported here for the row type below.
 */
// Both lines are needed and neither is redundant: the `export type ... from`
// re-exports the name for this module's importers, and a type-only re-export
// does NOT bind it locally, so `VatNonSupplyLine` below needs its own import.
export type { NonSupplyReason } from '../gl/nonSupplyAccounts';
import type { NonSupplyReason } from '../gl/nonSupplyAccounts';

/**
 * A posted line claiming VAT against an account on which no supply can arise.
 * Distinct from VatOnBalanceSheetLine: that rule is about which side of the
 * statements the contra leg sits on, this one about whether a supply happened.
 */
export interface VatNonSupplyLine {
  journalEntryId: string;
  entryNumber: string;
  entryDate: string;
  accountCode: string;
  accountName: string;
  /** Carried so the reader can see WHY it was flagged, not just that it was. */
  reason: NonSupplyReason | null;
  vatType: string;
  description: string;
  /** The flagged line's own movement — the expense or asset, NOT the tax. */
  amount: number;
  /**
   * VAT-control movement of the whole journal entry this line belongs to.
   * This is the number at risk: the flagged line carries the contra leg, so
   * `amount` shows R2 669 254,37 of salary where the defect is the
   * R400 388,14 of input tax beside it. Journal-level, so it repeats across
   * rows sharing a journal rather than pretending to split.
   *
   * NULL when no VAT leg could be identified — the tax may sit on a control
   * account with a NULL subtype, as Velocity's `SYS-9 VAT Payable` does. Not
   * the same fact as 0,00, and the UI must not render it as one.
   */
  journalVat: number | null;
}

export type InputVatSupportKind =
  | 'expense_claim' | 'captured_document' | 'credit_note' | 'vat_adjustment' | 'bank' | 'none';

/**
 * A journal claiming input VAT, and what supports it (vatInputSupport.ts).
 * `no_document` / `amount_mismatch` / `document_over_claimed` /
 * `unreadable_document_vat` rows go in `unsupportedInputVat` — visible, with
 * amounts and reasons, but NOT blocking (Hein, 2026-09-26): holding a valid
 * tax invoice is the vendor's legal responsibility, and it may be held
 * outside IsaFlow. `no_tax_invoice` rows are the same, non-blocking, "no tax
 * invoice on file" list.
 */
export interface InputVatSupportLine {
  journalEntryId: string;
  entryNumber: string;
  entryDate: string;
  source: string | null;
  description: string;
  /** Net vat_input movement on the journal. */
  claimedVat: number;
  supportKind: InputVatSupportKind;
  /** The VAT the linked document supports (bank: the rate/(1+rate) ceiling). Null when none. */
  documentVat: number | null;
  reason: 'no_document' | 'amount_mismatch' | 'document_over_claimed' | 'unreadable_document_vat' | 'no_tax_invoice';
  /** Captured document only: the net VAT every claim naming it has claimed to the period end. */
  documentClaimedVat: number | null;
}

/**
 * An issued invoice or approved bill carrying VAT with no GL journal
 * (vatUnpostedInvoices.ts). BLOCKING: its VAT is in neither the filed ledger
 * return nor the GL, so the recon cannot see it.
 */
export interface UnpostedInvoiceVatLine {
  invoiceId: string;
  invoiceKind: 'customer' | 'supplier';
  invoiceNumber: string;
  counterpartyName: string;
  invoiceDate: string;
  vat: number;
  reason: 'no_journal' | 'journal_not_posted' | 'journal_reversed';
}

/**
 * An issued invoice / approved bill marked "VAT declared outside IsaFlow"
 * (migration 705) — would otherwise be `UnpostedInvoiceVatLine`, but the
 * block has been lifted by an owner/admin. NON-blocking; not counted in
 * totalExceptions.
 */
export interface DeclaredElsewhereVatLine {
  invoiceId: string;
  invoiceKind: 'customer' | 'supplier';
  invoiceNumber: string;
  counterpartyName: string;
  invoiceDate: string;
  vat: number;
  markedAt: string;
  markedBy: string;
  /** Display name (or email) for markedBy, falling back to the raw id when no user row resolves. */
  markedByName: string;
  markedReason: string;
}

export interface VatControlRecon {
  outputVat201: number;
  outputGl: number;
  outputVariance: number;
  inputVat201: number;
  inputGl: number;
  inputVariance: number;
  netVat201: number;
  netGl: number;
  netVariance: number;
  unpostedCustomerVat: number;
  unpostedCustomerCount: number;
  unpostedSupplierVat: number;
  unpostedSupplierCount: number;
}

export interface VatExceptionsReport {
  periodStart: string;
  periodEnd: string;
  uncodedGlLines: UncodedGlVatLine[];
  uncodedGlLineCount: number;
  invoiceTaxCodeIssues: InvoiceTaxCodeIssue[];
  invoiceTaxCodeIssueCount: number;
  invoiceGlMismatches: InvoiceGlVatMismatch[];
  invoiceGlMismatchCount: number;
  vatOnBalanceSheetLines: VatOnBalanceSheetLine[];
  vatOnBalanceSheetCount: number;
  vatNonSupplyLines: VatNonSupplyLine[];
  vatNonSupplyCount: number;
  controlRecon: VatControlRecon;
  /** BLOCKING: issued invoices / approved bills with VAT and no journal. Capped list; per-side totals are on controlRecon. */
  unpostedInvoiceVat: UnpostedInvoiceVatLine[];
  unpostedInvoiceVatCount: number;
  /** NOT blocking: same population, marked "VAT declared outside IsaFlow" (migration 705). Capped list. */
  declaredElsewhereVat: DeclaredElsewhereVatLine[];
  declaredElsewhereVatCount: number;
  /**
   * NOT blocking (Hein, 2026-09-26): input VAT claimed with no document
   * behind it, or disagreeing with it. Still fully visible — amounts,
   * reasons, "Link tax invoice" action — because holding the tax invoice is
   * the vendor's legal responsibility and it may be held outside IsaFlow.
   * Capped list.
   */
  unsupportedInputVat: InputVatSupportLine[];
  unsupportedInputVatCount: number;
  /** NOT blocking: input VAT supported only by a bank line or a VAT adjustment. Capped list. */
  inputVatWithoutTaxInvoice: InputVatSupportLine[];
  inputVatWithoutTaxInvoiceCount: number;
  totalExceptions: number;
  /** True when generateVAT201 ran on missing sources — recon totals untrustworthy. */
  degradedData: boolean;
  degradedSources: string[];
}

// Row mappers and the small numeric/date helpers behind them live in
// vatExceptionsMappers.ts (item 11, file-size limit) and are re-exported here
// so every existing caller of this module keeps working unchanged.
export {
  toNum, r2, dateStr, totalCount,
  mapUncodedLine, mapTaxIssue, mapUnpostedInvoice, mapMismatch, mapDeclaredElsewhere,
} from './vatExceptionsMappers';
