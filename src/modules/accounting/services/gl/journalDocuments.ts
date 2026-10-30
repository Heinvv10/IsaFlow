/**
 * The document each journal was posted from, for the drill's source links
 * (budgets P3 §2.6; `lib/journalSourceHref`). Batched: one query per document
 * table over the whole set of journal ids (`gl_journal_entry_id = ANY(ids)`,
 * company-scoped), never a lookup per transaction row: a per-row LATERAL over
 * five tables took an 13 900-line account from 20 ms to 1.3 s (two of the
 * tables have no index on the column, so every row seq-scanned them).
 *
 * Deterministic: a journal two documents point at takes the first kind in
 * DOCUMENT_PRIORITY, and within one kind the lowest document id.
 * Queries run one after another (one pg client under withAuth).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

export type JournalDocumentKind =
  | 'customer_invoice' | 'credit_note' | 'customer_payment' | 'supplier_invoice' | 'supplier_credit_note' | 'supplier_payment';
export interface JournalDocumentRef { kind: JournalDocumentKind; id: string }

/** Which document wins when more than one points at a journal. */
export const DOCUMENT_PRIORITY: readonly JournalDocumentKind[] = [
  'customer_invoice', 'credit_note', 'customer_payment', 'supplier_invoice', 'supplier_credit_note', 'supplier_payment',
];

// The table names are literals in each query (never interpolated); credit_notes holds both kinds, split by `type`.
function read(kind: JournalDocumentKind, companyId: string, ids: string[]): Promise<DbRow[]> {
  switch (kind) {
    case 'customer_invoice':
      return sql`SELECT id::TEXT AS id, gl_journal_entry_id::TEXT AS je FROM customer_invoices
                  WHERE company_id = ${companyId}::UUID AND gl_journal_entry_id = ANY(${ids}::UUID[]) ORDER BY id` as Promise<DbRow[]>;
    case 'credit_note':
      return sql`SELECT id::TEXT AS id, gl_journal_entry_id::TEXT AS je FROM credit_notes
                  WHERE company_id = ${companyId}::UUID AND type = 'customer' AND gl_journal_entry_id = ANY(${ids}::UUID[]) ORDER BY id` as Promise<DbRow[]>;
    case 'customer_payment':
      return sql`SELECT id::TEXT AS id, gl_journal_entry_id::TEXT AS je FROM customer_payments
                  WHERE company_id = ${companyId}::UUID AND gl_journal_entry_id = ANY(${ids}::UUID[]) ORDER BY id` as Promise<DbRow[]>;
    case 'supplier_invoice':
      return sql`SELECT id::TEXT AS id, gl_journal_entry_id::TEXT AS je FROM supplier_invoices
                  WHERE company_id = ${companyId}::UUID AND gl_journal_entry_id = ANY(${ids}::UUID[]) ORDER BY id` as Promise<DbRow[]>;
    case 'supplier_credit_note':
      return sql`SELECT id::TEXT AS id, gl_journal_entry_id::TEXT AS je FROM credit_notes
                  WHERE company_id = ${companyId}::UUID AND type = 'supplier' AND gl_journal_entry_id = ANY(${ids}::UUID[]) ORDER BY id` as Promise<DbRow[]>;
    case 'supplier_payment':
      return sql`SELECT id::TEXT AS id, gl_journal_entry_id::TEXT AS je FROM supplier_payments
                  WHERE company_id = ${companyId}::UUID AND gl_journal_entry_id = ANY(${ids}::UUID[]) ORDER BY id` as Promise<DbRow[]>;
  }
}

/** journal id → the document it was posted from; a journal with none is absent from the map. */
export async function loadJournalDocuments(companyId: string, journalIds: readonly string[]): Promise<Map<string, JournalDocumentRef>> {
  const found = new Map<string, JournalDocumentRef>();
  const ids = [...new Set(journalIds)];
  if (ids.length === 0) return found;
  for (const kind of DOCUMENT_PRIORITY) {
    for (const r of await read(kind, companyId, ids)) {
      const je = String(r.je).toLowerCase();
      if (!found.has(je)) found.set(je, { kind, id: String(r.id) });
    }
  }
  return found;
}
