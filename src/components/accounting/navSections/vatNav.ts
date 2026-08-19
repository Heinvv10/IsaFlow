/**
 * Pure nav filter that hides VAT surfaces from companies that are not VAT
 * vendors (`companies.vat_period = 'none'`).
 *
 * Filtering happens at render time rather than in the static configs so the
 * nav trees stay a single source of truth. The VAT *settings* link is
 * deliberately kept — it is how a company that later registers with SARS
 * switches VAT back on.
 */
import { isFlyout, type NavItem, type Tab } from './types';

/** Page paths that only mean something to a registered VAT vendor. */
const VAT_SURFACES = [
  '/accounting/reports/vat-return',
  '/accounting/reports/vat-reconciliation',
  '/accounting/vat-adjustments',
  '/accounting/drc-vat',
  '/accounting/sars/vat201',
];

/** True for a link into a VAT-only page. Query strings are ignored. */
export function isVatSurfaceHref(href: string): boolean {
  const path = href.split('?')[0]!;
  return VAT_SURFACES.some((s) => path === s || path.startsWith(`${s}/`));
}

function stripItems(items: NavItem[]): NavItem[] {
  const kept: NavItem[] = [];
  for (const item of items) {
    if (isFlyout(item)) {
      const inner = stripItems(item.items);
      if (inner.length > 0) kept.push({ ...item, items: inner });
      continue;
    }
    if (!isVatSurfaceHref(item.href)) kept.push(item);
  }
  return kept;
}

function stripTab(tab: Tab): Tab | null {
  // A tab that exists purely for VAT goes entirely.
  if (tab.id === 'vat') return null;
  const items = tab.items ? stripItems(tab.items) : undefined;
  const topItems = tab.topItems?.filter((i) => !isVatSurfaceHref(i.href));
  // A tab whose every link was a VAT surface has nothing left to show.
  if (tab.items && items!.length === 0 && !(topItems?.length) && (!tab.href || isVatSurfaceHref(tab.href))) {
    return null;
  }
  return { ...tab, ...(items ? { items } : {}), ...(topItems ? { topItems } : {}) };
}

/**
 * Remove VAT-only entries from a nav tree. Returns `tabs` unchanged (same
 * reference) when the company IS a VAT vendor, so registered companies pay
 * nothing for this.
 */
export function stripVatNav(tabs: Tab[], isVatRegistered: boolean): Tab[] {
  if (isVatRegistered) return tabs;
  return tabs.map(stripTab).filter((t): t is Tab => t !== null);
}
