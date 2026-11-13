/** Types shared by the missing-documents query and service (core/missingDocumentsService). */

export const MISSING_DOCUMENT_TYPES = [
  'supplier_invoice', 'customer_invoice', 'credit_note', 'bank_transaction', 'vat_journal',
] as const;
export type MissingDocumentType = (typeof MISSING_DOCUMENT_TYPES)[number];

/** The entity types counted in SQL; vat_journal is classified by reports/vatInputSupport instead. */
export type SqlMissingDocumentType = Exclude<MissingDocumentType, 'vat_journal'>;

export interface MissingDocumentRow {
  entityType: MissingDocumentType;
  entityId: string;
  /** YYYY-MM-DD: invoice / credit note / bank / journal date. */
  documentDate: string;
  /** Absolute amount: gross total, absolute bank amount, or the input VAT a journal claims. */
  amount: number;
  /** `amount` in whole cents — the sort key. */
  cents: number;
  /** Invoice, credit note or journal number, or the bank line's reference. */
  reference: string | null;
  counterparty: string | null;
  description: string | null;
  status: string | null;
  /** vat_journal only: the input-VAT check's reason (no_document, no_tax_invoice, document_unlinked). */
  reason: string | null;
}

/** The sort key of the last row served: cents DESC, entity type ASC, id ASC. */
export interface MissingDocumentKey {
  cents: number;
  entityType: MissingDocumentType;
  id: string;
}

export interface MissingDocumentSummary {
  entityType: MissingDocumentType;
  /** Rows the type was checked over; null for vat_journal, which reports only its exceptions. */
  candidates: number | null;
  withDocument: number | null;
  missing: number;
  missingAmount: number;
}

export interface MissingDocumentFilters {
  companyId: string;
  types: readonly MissingDocumentType[];
  from: string;
  to: string;
  /** Compared against the absolute amount. */
  minAmount: number;
  limit: number;
  after: MissingDocumentKey | null;
}

export interface MissingDocumentPage {
  rows: MissingDocumentRow[];
  next: MissingDocumentKey | null;
  summary: MissingDocumentSummary[];
}

/** cents DESC, then entity type ASC, then id ASC — the order SQL (COLLATE "C") and JS must both produce. */
export function compareMissingKeys(a: MissingDocumentKey, b: MissingDocumentKey): number {
  if (a.cents !== b.cents) return b.cents - a.cents;
  if (a.entityType !== b.entityType) return a.entityType < b.entityType ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}
