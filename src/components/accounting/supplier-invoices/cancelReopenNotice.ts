/**
 * A cancelled bill can reopen a purchase order it no longer leaves fully billed (PR #1703), or find one a link closed by billing
 * meanwhile that it could not re-check (busy: maybe reopened by the request holding it, else left closed, still committing). The cancel's answer carries
 * `reopenedPurchaseOrders` (with `overBudget` / `outsideSlices` flags from the server's budget read), `uncheckedPurchaseOrders` and
 * `budgetWarnings`. The toast clips its second line to one row (`NOTICE_LINE_FITS`), so the facts go in the title, which wraps:
 * which POs reopened and to what, which stayed closed, capped "and k more"; the line says the budget consequence, short. A PO named by
 * several bills of a bulk cancel is named once (by its id). Read as untyped: a wrong shape shows nothing rather than throw.
 */
import { notify } from '@/utils/toast';
import { listNames, NOTICE_LINE_FITS } from '@/components/accounting/noticeLine';

type PoRef = { poId: string; poNumber: string; reopenedTo?: string; overBudget: boolean; outsideSlices: boolean };
/** The title wraps, but not without end: about two toast rows. */
const TITLE_FITS = NOTICE_LINE_FITS * 2;

function refs(v: unknown): PoRef[] {
  const out = new Map<string, PoRef>();
  for (const raw of Array.isArray(v) ? v : []) {
    const r = raw as { poId?: unknown; poNumber?: unknown; reopenedTo?: unknown; overBudget?: unknown; outsideSlices?: unknown } | null;
    if (typeof r?.poNumber !== 'string' || r.poNumber === '') continue;
    const key = typeof r.poId === 'string' && r.poId !== '' ? r.poId.toLowerCase() : r.poNumber;
    const had = out.get(key);
    out.set(key, {
      poId: key, poNumber: r.poNumber,
      ...(typeof r.reopenedTo === 'string' ? { reopenedTo: r.reopenedTo.replace(/_/g, ' ') } : had?.reopenedTo ? { reopenedTo: had.reopenedTo } : {}),
      overBudget: r.overBudget === true || had?.overBudget === true, outsideSlices: r.outsideSlices === true || had?.outsideSlices === true,
    });
  }
  return [...out.values()];
}

/** `head` and the labels, as many as fit `TITLE_FITS`, then "and k more". */
function capped(head: string, labels: string[]): string {
  for (let shown = labels.length; shown >= 1; shown--) {
    const more = labels.length - shown;
    const text = `${head}${labels.slice(0, shown).join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
    if (text.length <= TITLE_FITS || shown === 1) return text;
  }
  return head.trim();
}

/** The toast for what a cancel reopened (or could not re-check); null when it did neither. */
export function cancelReopenToast(reopenedRaw: unknown, uncheckedRaw: unknown): { title: string; line: string } | null {
  const reopened = refs(reopenedRaw);
  const unchecked = refs(uncheckedRaw).filter((u) => !reopened.some((r) => r.poId === u.poId));
  if (reopened.length === 0 && unchecked.length === 0) return null;
  const parts: string[] = [];
  if (reopened.length === 1) parts.push(`Purchase order ${reopened[0]!.poNumber} reopened to ${reopened[0]!.reopenedTo ?? 'its open status'}`);
  if (reopened.length > 1) parts.push(capped('Purchase orders reopened: ', reopened.map((r) => `${r.poNumber} to ${r.reopenedTo ?? 'open'}`)));
  if (unchecked.length > 0) parts.push(`${capped(unchecked.length === 1 ? 'Purchase order ' : 'Purchase orders ', unchecked.map((r) => r.poNumber))} could not be re-checked`);
  const over = reopened.filter((r) => r.overBudget);
  const offSlice = reopened.filter((r) => r.outsideSlices);
  const line = over.length > 0 ? listNames('Now over budget: ', over.map((r) => r.poNumber), 'Now over budget')
    : offSlice.length > 0 ? listNames('Outside the budget: ', offSlice.map((r) => r.poNumber), 'Outside the budget')
      : reopened.length > 0 ? listNames('Commits again: ', reopened.map((r) => r.poNumber), 'Commits spend again')
        : 'If still closed, still commits';
  return { title: parts.join('; '), line };
}

export function notifyCancelReopens(body: unknown): boolean {
  const data = (body as { data?: Record<string, unknown> } | null | undefined)?.data;
  if (!data || typeof data !== 'object') return false;
  const toast = cancelReopenToast(data.reopenedPurchaseOrders, data.uncheckedPurchaseOrders);
  if (toast) notify.warning(toast.title, toast.line);
  return toast !== null;
}
