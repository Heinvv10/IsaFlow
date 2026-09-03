/**
 * Row mapping and classification shared by the AR and AP subledger readers.
 *
 * Kept in one place so the two subledgers cannot drift on what "unageable"
 * means, and so `reconcile_subledger` can rely on the same classification for
 * both sides of the books.
 */

import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { SubledgerDocument, SubledgerSnapshot } from './subledgerTypes';

/** pg hands date columns back as `Date` OR as a string; fmtDate takes both. */
export function toDocument(r: DbRow): SubledgerDocument {
  return {
    id: String(r.id),
    documentNumber: r.document_number == null ? null : String(r.document_number),
    entityId: String(r.entity_id),
    entityName: String(r.entity_name ?? ''),
    documentDate: fmtDate(r.document_date as string | Date),
    // NULL is data. A COALESCE here would make the null-due-date exclusion find
    // nothing, which is exactly how R1,058,000 went missing.
    dueDate: r.due_date == null ? null : fmtDate(r.due_date as string | Date),
    totalAmount: Number(r.total_amount ?? 0),
    amountPaid: Number(r.amount_paid ?? 0),
    balance: Number(r.balance ?? 0),
  };
}

/** ISO-8601 max of the rows' `created_at`, or null when there are none. */
export function maxCreatedAt(rows: readonly DbRow[]): string | null {
  let max: string | null = null;
  for (const r of rows) {
    const raw = r.created_at;
    if (raw == null) continue;
    const iso = raw instanceof Date ? raw.toISOString() : String(raw);
    if (max === null || iso > max) max = iso;
  }
  return max;
}

export function buildSnapshot(
  documents: SubledgerDocument[],
  creditNotes: SubledgerDocument[],
  asAtDate: string,
  sourceRows: readonly DbRow[],
): SubledgerSnapshot {
  const unageable = documents.filter((d) => d.dueDate === null);
  const ageable = documents.filter((d) => d.dueDate !== null);
  // String comparison, not Date arithmetic: 'YYYY-MM-DD' sorts correctly as text.
  const afterAsAt = documents.filter((d) => d.documentDate > asAtDate);
  const subledgerTotal =
    documents.reduce((s, d) => s + d.balance, 0) + creditNotes.reduce((s, d) => s + d.balance, 0);
  return {
    documents,
    ageable,
    unageable,
    afterAsAt,
    creditNotes,
    subledgerTotal: Math.round(subledgerTotal * 100) / 100,
    postedThrough: maxCreatedAt(sourceRows),
  };
}
