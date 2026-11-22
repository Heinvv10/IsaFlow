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

/** The marker `useNavFlags` puts in the set when the user may read `moduleKey`. */
export const moduleReadFlag = (moduleKey: string): string => `module_read:${moduleKey}`;

/** Page path → the module (permission_modules.module_key) whose Read permission it needs. */
const MODULE_SURFACES: Readonly<Record<string, string>> = {
  '/payroll': 'payroll',
};

/** The feature flags the nav filters on (what `useNavFlags` asks `/api/features/check` about). */
export const FEATURE_NAV_FLAGS: readonly string[] = [...new Set(Object.values(FLAGGED_SURFACES))];

/** The modules whose pages the nav hides without Read (what `useNavFlags` asks `/api/accounting/my-permissions` about). */
export const NAV_MODULES: readonly string[] = [...new Set(Object.values(MODULE_SURFACES))];

/** The read markers of `NAV_MODULES`. */
export const MODULE_READ_NAV_FLAGS: readonly string[] = NAV_MODULES.map(moduleReadFlag);

/**
 * In the set while the answers are still loading (`useNavFlags`). It enables nothing: what it gates stays hidden. A
 * nav drawn as a row or a column passes `keepSlots` so a whole tab it would drop is kept as a `pending` slot instead,
 * laid out but invisible, and the tabs after it do not move when the answer lands (the shell layout-shift gate).
 */
export const NAV_PENDING = 'nav:pending';

/** Every flag the nav filters on: a set holding all of them hides nothing. */
export const NAV_FLAGS: readonly string[] = [...FEATURE_NAV_FLAGS, ...MODULE_READ_NAV_FLAGS];

/** The flag a link needs, or null. Query strings are ignored; the match is the exact page or below it. */
export function flagOfHref(href: string): string | null {
  const path = href.split('?')[0]!;
  for (const [surface, flag] of Object.entries(FLAGGED_SURFACES)) {
    if (path === surface || path.startsWith(`${surface}/`)) return flag;
  }
  for (const [surface, moduleKey] of Object.entries(MODULE_SURFACES)) {
    if (path === surface || path.startsWith(`${surface}/`)) return moduleReadFlag(moduleKey);
  }
  return null;
}

/** Whether the nav hides `href` from a user whose enabled flags are `enabled`. */
export function hidden(href: string, enabled: ReadonlySet<string>): boolean {
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

function stripTab(tab: Tab, enabled: ReadonlySet<string>, keepSlots: boolean): Tab | null {
  const items = tab.items ? stripItems(tab.items, enabled) : undefined;
  const topItems = tab.topItems?.filter((i) => !hidden(i.href, enabled));
  const links = tab.links?.filter((i) => !hidden(i.href, enabled));
  const href = tab.href && !hidden(tab.href, enabled) ? tab.href : undefined;
  const hadLinks = Boolean(tab.items?.length) || Boolean(tab.topItems?.length) || Boolean(tab.links?.length) || Boolean(tab.href);
  const hasLinks = Boolean(items?.length) || Boolean(topItems?.length) || Boolean(links?.length) || Boolean(href);
  if (hadLinks && !hasLinks) return keepSlots && enabled.has(NAV_PENDING) ? { ...tab, pending: true } : null;
  const next: Tab = { ...tab, ...(items ? { items } : {}), ...(topItems ? { topItems } : {}), ...(links ? { links } : {}) };
  if (href) next.href = href;
  else delete next.href;
  return next;
}

/**
 * Remove the links whose flag is not in `enabled`. Returns `tabs` unchanged (same reference) when every
 * nav flag is enabled, so a flagged company pays nothing for this. `keepSlots`: see `NAV_PENDING`.
 */
export function stripFlagNav(tabs: Tab[], enabled: ReadonlySet<string>, keepSlots = false): Tab[] {
  if (NAV_FLAGS.every((f) => enabled.has(f))) return tabs;
  return tabs.map((t) => stripTab(t, enabled, keepSlots)).filter((t): t is Tab => t !== null);
}
