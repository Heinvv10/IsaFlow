/**
 * The supplier's display name for the list's filter chip, taken from the rows
 * the list just loaded — never from the URL, which could name a different
 * supplier than the id it filters on.
 *
 * Returns the name to set, or null to leave the label alone: no supplier
 * filter, no rows yet, rows that still belong to the previous selection, or a
 * label that is already right.
 */

interface NamedRow { supplierId: string; supplierName?: string }

export function supplierLabelFromRows(rows: NamedRow[], supplierId: string, currentLabel: string): string | null {
  const row = rows[0];
  if (!supplierId || !row?.supplierName || row.supplierId !== supplierId) return null;
  return row.supplierName === currentLabel ? null : row.supplierName;
}
