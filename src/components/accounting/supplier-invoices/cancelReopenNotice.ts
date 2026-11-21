/**
 * A cancelled bill can reopen a purchase order it no longer leaves fully billed (PR #1703), or find one a link closed by billing
 * meanwhile that it could not re-check (left closed; it still counts its unbilled remainder). The cancel's answer carries
 * `reopenedPurchaseOrders`, `uncheckedPurchaseOrders` and `budgetWarnings`. The toast clips its second line to one row
 * (`NOTICE_LINE_FITS`), so the facts go in the title, which wraps: which POs reopened and to what, which stayed closed; the line says
 * the budget consequence, short. Read as untyped: a wrong shape shows nothing rather than throw.
 */
import { notify } from '@/utils/toast';
import { listNames } from '@/components/accounting/noticeLine';

type PoRef = { poNumber: string; reopenedTo?: string };

const refs = (v: unknown): PoRef[] => (Array.isArray(v) ? v : [])
  .map((r) => r as { poNumber?: unknown; reopenedTo?: unknown } | null)
  .filter((r): r is { poNumber: string; reopenedTo?: unknown } => typeof r?.poNumber === 'string' && r.poNumber !== '')
  .map((r) => ({ poNumber: r.poNumber, ...(typeof r.reopenedTo === 'string' ? { reopenedTo: r.reopenedTo.replace(/_/g, ' ') } : {}) }));

/** The toast for what a cancel reopened (or could not re-check); null when it did neither. */
export function cancelReopenToast(reopenedRaw: unknown, uncheckedRaw: unknown, warningsRaw: unknown): { title: string; line: string } | null {
  const reopened = refs(reopenedRaw);
  const unchecked = refs(uncheckedRaw);
  if (reopened.length === 0 && unchecked.length === 0) return null;
  const warnings = Array.isArray(warningsRaw) ? warningsRaw.filter((w): w is string => typeof w === 'string') : [];
  const parts: string[] = [];
  if (reopened.length === 1) parts.push(`Purchase order ${reopened[0]!.poNumber} reopened to ${reopened[0]!.reopenedTo ?? 'its open status'}`);
  if (reopened.length > 1) parts.push(`Purchase orders reopened: ${reopened.map((r) => `${r.poNumber} to ${r.reopenedTo ?? 'open'}`).join(', ')}`);
  if (unchecked.length > 0) parts.push(`${unchecked.length === 1 ? 'Purchase order' : 'Purchase orders'} ${unchecked.map((r) => r.poNumber).join(', ')} still closed (could not re-check)`);
  const says = (r: PoRef, what: string) => warnings.some((w) => w.startsWith('Reopened.') && w.includes(`Purchase order ${r.poNumber} `) && w.includes(what));
  const over = reopened.filter((r) => says(r, 'over budget'));
  const offSlice = reopened.filter((r) => says(r, 'outside the budgeted slices'));
  const line = over.length > 0 ? listNames('Now over budget: ', over.map((r) => r.poNumber), 'Now over budget')
    : offSlice.length > 0 ? listNames('Outside the budget: ', offSlice.map((r) => r.poNumber), 'Outside the budget')
      : reopened.length > 0 ? listNames('Commits again: ', reopened.map((r) => r.poNumber), 'Commits spend again')
        : 'Still counts its unbilled remainder';
  return { title: parts.join('; '), line };
}

export function notifyCancelReopens(body: unknown): boolean {
  const data = (body as { data?: Record<string, unknown> } | null | undefined)?.data;
  if (!data || typeof data !== 'object') return false;
  const toast = cancelReopenToast(data.reopenedPurchaseOrders, data.uncheckedPurchaseOrders, data.budgetWarnings);
  if (toast) notify.warning(toast.title, toast.line);
  return toast !== null;
}
