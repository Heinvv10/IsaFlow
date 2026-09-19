/**
 * One database row of the unapplied-payment basis, turned into one reported
 * row — and the arithmetic that decides whether it is a row at all.
 *
 * Split out of `unappliedPaymentBasis` when the refund work took that file past
 * the 300-line cap. The seam is altitude: that file owns WHICH payments the
 * question covers (the predicate, the status filter, the completeness
 * aggregate), and this one owns what a single row MEANS once it has been
 * selected. The predicate and this mapper must agree — the SQL keeps the scan
 * small, the JavaScript is the rule — and `unappliedPaymentBasis.test.ts`
 * asserts both halves so neither can drift alone.
 */

import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';

/**
 * What kind of on-account entry a basis row is. A `'refund'` (migration 681)
 * carries a NEGATIVE `total_amount` and no allocations; everything else is
 * positive cash awaiting application.
 */
export type UnappliedPaymentKind = 'payment' | 'refund';

export interface UnappliedPaymentBasisRow {
  paymentId: string;
  /** Payment / receipt number, '' when the row carries none. */
  paymentNumber: string;
  paymentDate: string;
  /** Null when the counterparty row is missing or soft-deleted. */
  entityId: string | null;
  entityName: string | null;
  /** Whether the counterparty resolved. Stated BY the query, never inferred. */
  attributed: boolean;
  totalAmount: number;
  /** Σ allocations, capped into `[0, max(totalAmount, 0)]`. */
  allocatedAmount: number;
  /**
   * `totalAmount − allocatedAmount`, rounded to cents. NEVER zero on a row, and
   * NEGATIVE on a refund — cash the company sent back, which nets against the
   * same entity's other remainders rather than adding to them.
   */
  unappliedAmount: number;
  /**
   * `'refund'` for a negative on-account entry (migration 681), `'payment'` for
   * everything else. Stated by the query rather than inferred from the sign, so
   * a reader that must render the two differently is not deriving a document
   * type from an arithmetic accident.
   */
  kind: UnappliedPaymentKind;
  status: string;
  reference: string | null;
  description: string | null;
  /** The journal that put this cash on the control account, when there is one. */
  journalEntryId: string | null;
  /** ISO-8601, or null. Never now(). */
  createdAt: string | null;
}

export function toIso(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  return raw instanceof Date ? raw.toISOString() : String(raw);
}

export function round2(n: number): number {
  const r = Math.round(n * 100) / 100;
  return r === 0 ? 0 : r;
}

/**
 * The rows the query returned, as the rows the caller reports. Pure: no reads,
 * no clock, nothing that can differ between a test and production.
 */
export function mapBasisRows(rows: readonly DbRow[]): UnappliedPaymentBasisRow[] {
  const out: UnappliedPaymentBasisRow[] = [];
  for (const r of rows) {
    const totalAmount = Number(r.total_amount ?? 0);
    // `Math.max(totalAmount, 0)` is the allocation cap, and the zero is what
    // makes a REFUND work. The cap exists so an over-allocated payment cannot
    // read as negative unapplied cash quietly netting off a real remainder
    // elsewhere in the same total. Capping at a NEGATIVE total instead makes
    // the remainder exactly zero, which dropped every refund out of every
    // figure built on this basis — the credit then read as though the cash had
    // never come back. A refund carries no allocations, so the cap is 0 and the
    // remainder is the refund itself.
    const allocatedAmount = Math.min(Number(r.allocated_amount ?? 0), Math.max(totalAmount, 0));
    const unappliedAmount = round2(totalAmount - allocatedAmount);
    // The SQL filter is `<> 0` at full precision; this is the cents threshold.
    // Both are needed: the first keeps the scan small, the second is the rule.
    // NOT `<= 0` any more: a refund's remainder is negative and is a row.
    if (unappliedAmount === 0) continue;
    const attributed = r.attributed === true;
    out.push({
      paymentId: String(r.id),
      paymentNumber: r.document_number ? String(r.document_number) : '',
      paymentDate: fmtDate(r.document_date as string | Date),
      entityId: attributed && r.entity_id ? String(r.entity_id) : null,
      entityName: attributed && r.entity_name != null ? String(r.entity_name) : null,
      attributed,
      totalAmount,
      allocatedAmount: round2(allocatedAmount),
      unappliedAmount,
      kind: r.payment_method === 'refund' ? 'refund' : 'payment',
      status: String(r.status ?? ''),
      reference: r.reference ? String(r.reference) : null,
      description: r.description ? String(r.description) : null,
      journalEntryId: r.gl_journal_entry_id ? String(r.gl_journal_entry_id) : null,
      createdAt: toIso(r.created_at),
    });
  }
  return out;
}
