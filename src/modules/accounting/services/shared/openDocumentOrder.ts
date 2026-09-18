/**
 * The FIFO order, applied in memory.
 *
 * It used to be the SQL `ORDER BY`, which forced the row LOCK into the same
 * order — and locking bills in (invoice_date, due_date, id) sequence is a
 * deadlock against every other path on this money route, all of which lock by
 * `id` (`supplierAllocationLines#lockBillCandidates`, `receiptAllocationLines`,
 * `bankAllocationUnwind`). Two requests taking one pair of bills in opposite
 * orders raise 40P01, which aborts the whole transaction and, inside a bulk
 * batch, every line already posted beside it.
 *
 * So the query locks by id and the ordering lands here. Pure, and shared by AP
 * and AR so the two subledgers cannot consume cash in different orders.
 *
 * The tie-breakers are part of the contract, not decoration. `invoice_date`
 * alone leaves same-day documents in whatever order the rows arrived, so
 * "oldest first" would mean "whichever row the planner reached first" and two
 * runs over the same books could settle different documents.
 */

import type { SimulationDocument } from './autoApplySimulation';

export interface OpenDocumentRow extends SimulationDocument {
  /**
   * `YYYY-MM-DD`, or EMPTY when the column is null.
   *
   * `customer_invoices.invoice_date` is nullable — only the AP side's is NOT
   * NULL — so this is a real shape, not a defensive one. An undated invoice
   * sorts LAST whichever direction the caller asked for; see below.
   */
  invoiceDate: string;
  /** `YYYY-MM-DD`, or null — a document with no due date sorts LAST when oldest-first. */
  dueDate: string | null;
}

/** A missing due date sorts last ascending and first descending, matching NULLS LAST / NULLS FIRST. */
function compareDueDate(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

/** An undated document — `customer_invoices.invoice_date` is nullable. */
function undated(row: OpenDocumentRow): boolean {
  return row.invoiceDate === '';
}

function compare(a: OpenDocumentRow, b: OpenDocumentRow): number {
  if (a.invoiceDate !== b.invoiceDate) return a.invoiceDate < b.invoiceDate ? -1 : 1;
  const due = compareDueDate(a.dueDate, b.dueDate);
  if (due !== 0) return due;
  return a.invoiceId < b.invoiceId ? -1 : a.invoiceId > b.invoiceId ? 1 : 0;
}

/**
 * Oldest first, or the mirror of it — with ONE deliberate exception.
 *
 * AN UNDATED DOCUMENT IS LAST IN BOTH DIRECTIONS, and that is not the mirror.
 * Reversing the whole comparison would put a null `invoice_date` FIRST under
 * newest-first, so cash would settle an invoice with no date before every
 * invoice that has one — and an empty string sorting before '2026-01-01' put it
 * first under oldest-first too, which is worse: the walk would prefer the one
 * document whose age nobody can state. It has no age, so it is never preferred.
 *
 * Everything else does mirror: `due_date` and `id` reverse with the direction,
 * matching `ORDER BY … DESC, due_date DESC NULLS FIRST, id DESC`, which is what
 * the two statements said before the ordering moved out of SQL.
 */
export function orderOpenDocuments(
  rows: readonly OpenDocumentRow[],
  oldestFirst: boolean,
): SimulationDocument[] {
  const sorted = [...rows].sort((a, b) => {
    // Decided BEFORE the direction is applied, so it survives the negation.
    if (undated(a) !== undated(b)) return undated(a) ? 1 : -1;
    const base = compare(a, b);
    return oldestFirst ? base : -base;
  });
  return sorted.map(({ invoiceId, invoiceNumber, outstanding }) => ({
    invoiceId, invoiceNumber, outstanding,
  }));
}
