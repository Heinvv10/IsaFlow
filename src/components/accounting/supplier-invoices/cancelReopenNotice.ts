/**
 * A cancelled bill can reopen a purchase order it no longer leaves fully billed (PR #1703): the cancel's answer carries
 * `reopenedPurchaseOrders` and `budgetWarnings` (one per reopened PO, then its budget read). The detail page shows them in one
 * warning toast; nothing reopened, nothing shown. Read as untyped: a wrong shape shows nothing rather than throw.
 */
import { notify } from '@/utils/toast';

export function notifyCancelReopens(body: unknown): number {
  const data = (body as { data?: Record<string, unknown> } | null | undefined)?.data;
  if (!data || typeof data !== 'object') return 0;
  const warnings = Array.isArray(data.budgetWarnings) ? data.budgetWarnings.filter((w): w is string => typeof w === 'string' && w !== '') : [];
  if (warnings.length === 0) return 0;
  const reopened = Array.isArray(data.reopenedPurchaseOrders)
    ? (data.reopenedPurchaseOrders as Array<{ poNumber?: unknown } | null>).map((r) => (typeof r?.poNumber === 'string' ? r.poNumber : '')).filter(Boolean)
    : [];
  const title = reopened.length === 1 ? `Purchase order ${reopened[0]} reopened`
    : reopened.length > 1 ? `${reopened.length} purchase orders reopened` : 'A purchase order reopened';
  notify.warning(title, warnings.join(' '));
  return warnings.length;
}
