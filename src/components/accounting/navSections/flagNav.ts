/**
 * Pure nav filter that hides pages behind a feature flag the active company
 * does not have (budgets P6 spec §13.14). The nav trees list every page; this
 * strips the flagged ones at render time, beside `stripVatNav`, at every place
 * the nav is drawn or indexed: `AccountingNav`, `layout/DrawerNav`,
 * `layout/SidebarNav`, `SecondaryModuleNav` and `navIndex` (command palette,
 * page titles). Hiding a link is cosmetic: the page and its API check the flag
 * themselves.
 */
import { isFlyout, type NavItem, type Tab } from './types';

export const THREE_WAY_HREF = '/accounting/budgets/three-way';

/** Page path → the feature flag code it needs. */
const FLAGGED_SURFACES: Readonly<Record<string, string>> = {
  [THREE_WAY_HREF]: 'budgets_three_way',
};

/** Every flag the nav filters on (what `useNavFlags` asks the server about). */
export const NAV_FLAGS: readonly string[] = [...new Set(Object.values(FLAGGED_SURFACES))];

/** The flag a link needs, or null. Query strings are ignored; the match is the exact page or below it. */
export function flagOfHref(href: string): string | null {
  const path = href.split('?')[0]!;
  for (const [surface, flag] of Object.entries(FLAGGED_SURFACES)) {
    if (path === surface || path.startsWith(`${surface}/`)) return flag;
  }
  return null;
}

function hidden(href: string, enabled: ReadonlySet<string>): boolean {
  const flag = flagOfHref(href);
  return flag !== null && !enabled.has(flag);
}

function stripItems(items: NavItem[], enabled: ReadonlySet<string>): NavItem[] {
  const kept: NavItem[] = [];
  for (const item of items) {
    if (isFlyout(item)) {
      const inner = stripItems(item.items, enabled);
      if (inner.length > 0) kept.push({ ...item, items: inner });
    } else if (!hidden(item.href, enabled)) {
      kept.push(item);
    }
  }
  return kept;
}

function stripTab(tab: Tab, enabled: ReadonlySet<string>): Tab | null {
  const items = tab.items ? stripItems(tab.items, enabled) : undefined;
  const topItems = tab.topItems?.filter((i) => !hidden(i.href, enabled));
  const links = tab.links?.filter((i) => !hidden(i.href, enabled));
  const href = tab.href && !hidden(tab.href, enabled) ? tab.href : undefined;
  const hadLinks = Boolean(tab.items?.length) || Boolean(tab.topItems?.length) || Boolean(tab.links?.length) || Boolean(tab.href);
  const hasLinks = Boolean(items?.length) || Boolean(topItems?.length) || Boolean(links?.length) || Boolean(href);
  if (hadLinks && !hasLinks) return null;
  const next: Tab = { ...tab, ...(items ? { items } : {}), ...(topItems ? { topItems } : {}), ...(links ? { links } : {}) };
  if (href) next.href = href;
  else delete next.href;
  return next;
}

/**
 * Remove the links whose flag is not in `enabled`. Returns `tabs` unchanged (same reference) when every
 * nav flag is enabled, so a flagged company pays nothing for this.
 */
export function stripFlagNav(tabs: Tab[], enabled: ReadonlySet<string>): Tab[] {
  if (NAV_FLAGS.every((f) => enabled.has(f))) return tabs;
  return tabs.map((t) => stripTab(t, enabled)).filter((t): t is Tab => t !== null);
}
