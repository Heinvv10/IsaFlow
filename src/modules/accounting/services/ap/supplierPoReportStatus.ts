/**
 * The status filter of the supplier POs report (`pages/api/accounting/reports-supplier-pos.ts`) after migration 1022 retired
 * supplier_purchase_orders (Codex gate on PR #1703): a caller still sending a retired status gets what 1022 copied it as, never a
 * silent empty report. sent -> approved (1022 copied every sent order so). invoiced and partially_invoiced were copied by quantity or
 * by billing (approved, partially_received, received or closed), so no single status stands for either: refused, as is any status
 * the canonical table does not have.
 */
export const CANONICAL_PO_STATUSES = ['draft', 'submitted', 'approved', 'partially_received', 'received', 'closed', 'cancelled'] as const;
const RETIRED: Readonly<Record<string, string>> = { sent: 'approved' };

export function reportStatusFilter(status: string | null): { status: string | null } | { refusal: string } {
  if (status === null) return { status: null };
  if (RETIRED[status]) return { status: RETIRED[status]! };
  if ((CANONICAL_PO_STATUSES as readonly string[]).includes(status)) return { status };
  const why = status === 'partially_invoiced' || status === 'invoiced'
    ? `status ${status} was retired with supplier purchase orders (migration 1022) and has no single canonical status`
    : `status ${status} is not a purchase order status`;
  return { refusal: `${why}; use one of: ${CANONICAL_PO_STATUSES.join(', ')}` };
}
