/**
 * Offset paging shared by the list tools that page by position
 * (list_customers, list_suppliers, list_invoices; list_supplier_invoices
 * predates it). Every page answers `next_offset` — null on the last page — so
 * an agent walks a directory by feeding it back rather than doing arithmetic
 * on a total it may have misread.
 *
 * Offset, not a keyset cursor: these services already page by position for the
 * UI, and list_invoices sorts on a NULLABLE invoice_date. The cost is that a row
 * created mid-walk can shift a page and serve one row twice; each query orders
 * on a total order (id as the tiebreak) so nothing else moves between pages.
 */

export const OFFSET_SCHEMA = {
  type: 'integer',
  minimum: 0,
  description: 'Rows to skip. Pass the previous page\'s next_offset; omit for the first page.',
} as const;

/** The requested offset, 0 when omitted, or the refusal message. */
export function parseOffset(args: Record<string, unknown>): number | string {
  if (args.offset === undefined || args.offset === null) return 0;
  const n = typeof args.offset === 'number' ? args.offset : Number.NaN;
  if (!Number.isInteger(n) || n < 0) return 'offset must be a non-negative integer';
  return n;
}

/** next_offset for a page whose total is known. */
export function nextOffsetFromTotal(offset: number, served: number, total: number): number | null {
  return served > 0 && offset + served < total ? offset + served : null;
}
