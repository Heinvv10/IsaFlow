/**
 * Flat, searchable index of every page the top nav can reach, with the trail
 * that leads there. Pure, so the command palette and the document-title
 * builder share one source with the nav menus.
 *
 *   const index = buildNavIndex(TABS, isVatRegistered);   // memoise per company
 *   trailForPath(router.asPath, index)                    // { href, label, trail } | null
 *
 * `trail` is the ANCESTORS only, root first, and never contains `label`:
 * Tax Invoices -> { label: 'Tax Invoices', trail: ['Sales', 'Transactions'] }.
 * A top-level tab such as Dashboard has an empty trail.
 */
import { isFlyout, type NavItem, type Tab } from './types';
import { stripVatNav } from './vatNav';
import { mostSpecificActiveHref } from './activeTab';

export interface NavIndexEntry {
  href: string;
  label: string;
  trail: string[];
  /** A gear-icon settings link. Those into a `?tab=` view share their page with the other tabs, so they never own it. */
  isSetting?: true;
}

/** A section named like its only link ("Transactions" > "Transactions") would repeat the label in its own trail. */
function withoutLabel(trail: string[], label: string): string[] {
  return trail.at(-1) === label ? trail.slice(0, -1) : trail;
}

function walk(items: NavItem[], trail: string[], out: NavIndexEntry[]): void {
  for (const item of items) {
    if (isFlyout(item)) walk(item.items, [...trail, item.section], out);
    else {
      out.push({
        href: item.href, label: item.label, trail: withoutLabel(trail, item.label),
        ...(item.isSetting ? { isSetting: true as const } : {}),
      });
    }
  }
}

/** First entry per href wins, so call order is priority order. */
function addUnique(into: NavIndexEntry[], seen: Set<string>, entries: NavIndexEntry[]): void {
  for (const e of entries) {
    if (seen.has(e.href)) continue;
    seen.add(e.href);
    into.push(e);
  }
}

export function buildNavIndex(tabs: Tab[], isVatRegistered: boolean): NavIndexEntry[] {
  const index: NavIndexEntry[] = [];
  const seen = new Set<string>();
  for (const tab of stripVatNav(tabs, isVatRegistered)) {
    // Sections carry the canonical label, so they outrank the daily-link
    // shortcuts, which in turn outrank the tab's own landing href.
    const sections: NavIndexEntry[] = [];
    walk(tab.items ?? [], [tab.label], sections);
    const links = (tab.links ?? []).map((l) => ({ href: l.href, label: l.label, trail: [tab.label] }));
    const quick = (tab.topItems ?? []).map((l) => ({ href: l.href, label: l.label, trail: [tab.label] }));
    const landing = tab.href ? [{ href: tab.href, label: tab.label, trail: [] as string[] }] : [];
    addUnique(index, seen, [...sections, ...links, ...quick, ...landing]);
  }
  return index;
}

/**
 * Hrefs that own only their exact path: matching every sub-path would claim unrelated pages
 * (/accounting is the Dashboard, /accounting/sars the calendar; its sub-pages have their own entries).
 */
const EXACT_ONLY = new Set(['/accounting', '/accounting/sars']);

/**
 * The entry whose href is the most specific owner of `asPath`, or null. An exact-only entry does not own a page
 * that selects its own sub-view with `?tab=` (the dashboard's Reports tab is not the Dashboard), and a settings
 * link into a `?tab=` view never owns a page: `company-settings?tab=general` is not "Banking".
 */
export function trailForPath(asPath: string, index: NavIndexEntry[]): NavIndexEntry | null {
  const [withQuery = ''] = asPath.split('#');
  const [pagePath = '', query = ''] = withQuery.split('?');
  const hasTab = new URLSearchParams(query).has('tab');
  const candidates = index.filter((e) => {
    if (e.isSetting && e.href.includes('?')) return false;
    return !EXACT_ONLY.has(e.href) || (pagePath === e.href && !hasTab);
  });
  const best = mostSpecificActiveHref(candidates.map((e) => e.href), asPath);
  return best === null ? null : (candidates.find((e) => e.href === best) ?? null);
}
