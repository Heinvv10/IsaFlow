/**
 * The payment documents a bank allocation's journal carries, and whether the
 * journal carries anything besides them — for the paths that act on ONE
 * document of a journal.
 *
 * Before split lines could name suppliers and customers (bankSplitContacts.ts)
 * a bank allocation's journal carried at most one document, and the paths that
 * find "the" document of a journal relied on it: the reversal gate read one
 * document's arm (`allocationFacts`), and a void of one payment reversed the
 * whole bank line. A split now carries one document per contact line, plus
 * its GL-account lines. A journal carries something besides its documents
 * exactly when their totals do not add up to the journal's: each document's
 * control leg is its own total, so the rest of the journal is GL lines.
 *
 * ASSUMED, and checked against every writer as of PR #711: a whole-line
 * payment journal is the bank leg plus ONE control leg of the document's
 * total (allocateTransaction, processSupplierPayment, the receipt post, both
 * refund documents, batches). A payment journal that ever gains another debit
 * leg (a fee, a discount) reads as a split here and its void is refused
 * `split_part` — teach this check that leg; do not loosen the refusal.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

/** `bank_transactions.allocated_entity_name` of a split allocation. */
export const SPLIT_ALLOCATION_NAME = 'Split allocation';

export interface JournalDocument {
  kind: 'supplier' | 'customer';
  createdBy: string | null;
  /** Signed: a refund document is negative. */
  total: number;
  live: boolean;
}

export interface JournalDocuments {
  docs: JournalDocument[];
  /** The journal's total debits: the bank line's amount. */
  journalTotal: number;
  /** Lines no document accounts for — a split's GL-account part. */
  hasOtherLines: boolean;
}

const sumAbs = (docs: readonly JournalDocument[]) => Math.round(docs.reduce((s, d) => s + Math.abs(d.total), 0) * 100) / 100;

export async function documentsOnJournal(companyId: string, journalId: string): Promise<JournalDocuments> {
  const rows = (await sql`
    SELECT 'supplier' AS kind, created_by::TEXT AS created_by, total_amount AS total, status <> 'cancelled' AS live
      FROM supplier_payment_batches WHERE company_id = ${companyId}::UUID AND gl_journal_entry_id = ${journalId}::UUID
    UNION ALL
    SELECT 'supplier', created_by::TEXT, total_amount, status <> 'cancelled'
      FROM supplier_payments WHERE company_id = ${companyId}::UUID AND gl_journal_entry_id = ${journalId}::UUID
    UNION ALL
    SELECT 'customer', created_by::TEXT, total_amount, status <> 'cancelled'
      FROM customer_payments WHERE company_id = ${companyId}::UUID AND gl_journal_entry_id = ${journalId}::UUID
  `) as DbRow[];
  const [sum] = (await sql`
    SELECT COALESCE(SUM(debit), 0) AS total FROM gl_journal_lines
    WHERE journal_entry_id = ${journalId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  const docs: JournalDocument[] = rows.map((r) => ({
    kind: r.kind === 'customer' ? 'customer' : 'supplier',
    createdBy: r.created_by == null ? null : String(r.created_by),
    total: Number(r.total ?? 0),
    live: r.live === true,
  }));
  const journalTotal = Number(sum?.total ?? 0);
  return { docs, journalTotal, hasOtherLines: docs.length > 0 && sumAbs(docs) < journalTotal - 0.005 };
}

/**
 * Why ONE document of `journalId` may not be voided on its own, or null. Voiding
 * it through the bank line reverses the whole line — every other document on the
 * journal and every GL line of the split — so the void is refused and the user
 * is sent to the split's own reversal, which says what it undoes.
 */
export async function splitPartRefusal(companyId: string, journalId: string, label: string): Promise<string | null> {
  const { docs, journalTotal } = await documentsOnJournal(companyId, journalId);
  const live = docs.filter((d) => d.live);
  const otherLines = live.length > 0 && sumAbs(live) < journalTotal - 0.005;
  if (live.length <= 1 && !otherLines) return null;
  const parts = [live.length > 1 ? `${live.length} payment documents` : '', otherLines ? 'GL-account lines' : '']
    .filter(Boolean).join(' and ');
  return `${label} is one part of a split bank allocation (${parts}): voiding it alone would reverse the whole bank `
    + 'line. Reverse the split instead (reverse_bank_allocation, or Reverse on the bank screen).';
}
