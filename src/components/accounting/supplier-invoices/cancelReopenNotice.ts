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

/** A PO number longer than this is cut (review r14 M1: one label must not blow the title). */
const LABEL_FITS = 24;
const cut = (label: string) => (label.length > LABEL_FITS ? `${label.slice(0, LABEL_FITS - 1)}\u2026` : label);

/** One part of the title: `shown` labels then "and k more"; `shown` 0 = the count alone. */
function part(kind: 'reopened' | 'unchecked', refsIn: PoRef[], shown: number): string {
  const n = refsIn.length;
  if (shown === 0) return kind === 'reopened' ? `${n} purchase order${n === 1 ? '' : 's'} reopened` : `${n} purchase order${n === 1 ? '' : 's'} could not be re-checked`;
  const more = n - shown;
  const tail = more > 0 ? ` and ${more} more` : '';
  if (kind === 'reopened') {
    if (n === 1) return `Purchase order ${cut(refsIn[0]!.poNumber)} reopened to ${refsIn[0]!.reopenedTo ?? 'its open status'}`;
    return `Purchase orders reopened: ${refsIn.slice(0, shown).map((r) => `${cut(r.poNumber)} to ${r.reopenedTo ?? 'open'}`).join(', ')}${tail}`;
  }
  return `${n === 1 ? 'Purchase order' : 'Purchase orders'} ${refsIn.slice(0, shown).map((r) => cut(r.poNumber)).join(', ')}${tail} could not be re-checked`;
}

/**
 * The title, the WHOLE of it within `TITLE_FITS` (review r14 M1): the reopened part, the unchecked part and their joiner share the
 * budget. The part showing more labels gives one up first; at one label each, a part falls back to its count, the reopened first.
 */
function title(reopened: PoRef[], unchecked: PoRef[]): string {
  let r = reopened.length;
  let u = unchecked.length;
  const text = () => [reopened.length > 0 ? part('reopened', reopened, r) : '', unchecked.length > 0 ? part('unchecked', unchecked, u) : '']
    .filter((t) => t !== '').join('; ');
  while (text().length > TITLE_FITS) {
    if (r > 1 || u > 1) { if (r >= u) r -= 1; else u -= 1; } else if (r === 1) r = 0; else if (u === 1) u = 0; else break;
  }
  return text();
}

/** The toast for what a cancel reopened (or could not re-check); null when it did neither. */
export function cancelReopenToast(reopenedRaw: unknown, uncheckedRaw: unknown): { title: string; line: string } | null {
  const reopened = refs(reopenedRaw);
  const unchecked = refs(uncheckedRaw).filter((u) => !reopened.some((r) => r.poId === u.poId));
  if (reopened.length === 0 && unchecked.length === 0) return null;
  const over = reopened.filter((r) => r.overBudget);
  const offSlice = reopened.filter((r) => r.outsideSlices);
  const line = over.length > 0 ? listNames('Now over budget: ', over.map((r) => r.poNumber), 'Now over budget')
    : offSlice.length > 0 ? listNames('Outside the budget: ', offSlice.map((r) => r.poNumber), 'Outside the budget')
      : reopened.length > 0 ? listNames('Commits again: ', reopened.map((r) => r.poNumber), 'Commits spend again')
        : 'If still closed: under-billed, still commits';
  return { title: title(reopened, unchecked), line };
}

export function notifyCancelReopens(body: unknown): boolean {
  const data = (body as { data?: Record<string, unknown> } | null | undefined)?.data;
  if (!data || typeof data !== 'object') return false;
  const toast = cancelReopenToast(data.reopenedPurchaseOrders, data.uncheckedPurchaseOrders);
  if (toast) notify.warning(toast.title, toast.line, { live: true });
  return toast !== null;
}
