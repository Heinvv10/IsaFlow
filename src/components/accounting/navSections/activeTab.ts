/**
 * Route → tab id resolver for the top nav.
 *
 * Tabs: dashboard · sales · purchases · banking · payroll · tax · reports ·
 *       month-end · portfolio · library (settings — cog only)
 *
 * getActiveModuleId returns the raw module id; getActiveTabId collapses the
 * library-only modules (inventory, accounting, practice) → 'library'.
 *
 * NOTE on getActiveModuleId: the `startsWith('/accounting/customer-')` style
 * prefixes below are deliberate. They claim a FAMILY of sibling routes
 * (customer-invoices, customer-quotes, ...) that no single path segment names,
 * so they must stay raw prefixes. Nav LINK matching is different: use
 * pathMatchesHref, which respects segment boundaries.
 */

/** Raw module-id resolver — the active module without Library collapsing. */
export function getActiveModuleId(
  pathname: string,
  query: Record<string, string | string[] | undefined>,
): string {
  if (pathname === '/accounting') {
    const tab = typeof query.tab === 'string' ? query.tab : undefined;
    if (tab === 'chart-of-accounts' || tab === 'journal-entries' || tab === 'fiscal-periods') return 'accounting';
    if (tab === 'reports') return 'reports';
    return 'dashboard';
  }

  // ── Settings (cog) ──────────────────────────────────────────────────────
  if (
    pathname.startsWith('/accounting/company-settings') ||
    pathname.startsWith('/accounting/user-access') ||
    pathname.startsWith('/accounting/my-account') ||
    pathname.startsWith('/accounting/document-capture') ||
    pathname.startsWith('/accounting/approvals') ||
    pathname.startsWith('/accounting/recurring-transactions') ||
    pathname.startsWith('/accounting/webhooks') ||
    pathname.startsWith('/accounting/time-tracking') ||
    pathname.startsWith('/accounting/timesheets') ||
    pathname.startsWith('/accounting/duplicates') ||
    pathname.startsWith('/accounting/migration') ||
    pathname.startsWith('/accounting/sage-migration') ||
    pathname.startsWith('/accounting/gl-import') ||
    pathname.startsWith('/accounting/group') ||
    pathname.startsWith('/accounting/consolidation')
  ) {
    return 'settings';
  }

  // ── Sales (formerly Customers) ──────────────────────────────────────────
  if (
    pathname.startsWith('/accounting/customers') ||
    pathname.startsWith('/accounting/customer-') ||
    pathname.startsWith('/accounting/recurring-invoices') ||
    pathname.startsWith('/accounting/credit-notes') ||
    pathname.startsWith('/accounting/write-offs') ||
    pathname.startsWith('/accounting/debtors-manager') ||
    pathname.startsWith('/accounting/ar-aging') ||
    pathname.startsWith('/accounting/statement-run') ||
    pathname.startsWith('/accounting/statements') ||
    pathname.startsWith('/accounting/dunning') ||
    pathname.startsWith('/accounting/ar/') ||
    pathname === '/accounting/reports/sales-by-customer' ||
    pathname === '/accounting/reports/unallocated-receipts' ||
    (pathname.startsWith('/accounting/adjustments') && query.type === 'customer')
  ) {
    return 'sales';
  }

  // ── Purchases (formerly Suppliers) ──────────────────────────────────────
  if (
    pathname.startsWith('/accounting/suppliers') ||
    pathname.startsWith('/accounting/supplier-') ||
    pathname.startsWith('/accounting/purchase-orders') ||
    pathname.startsWith('/accounting/goods-received') ||
    pathname.startsWith('/accounting/batch-payments') ||
    pathname.startsWith('/accounting/ap-aging') ||
    pathname === '/accounting/reports/purchases-by-supplier' ||
    pathname === '/accounting/reports/supplier-pos' ||
    pathname === '/accounting/reports/unallocated-payments' ||
    (pathname.startsWith('/accounting/adjustments') && query.type === 'supplier')
  ) {
    return 'purchases';
  }

  // ── Inventory (formerly Items) ──────────────────────────────────────────
  if (
    pathname.startsWith('/accounting/items') ||
    pathname.startsWith('/accounting/item-') ||
    pathname === '/accounting/reports/item-listing' ||
    pathname === '/accounting/reports/sales-by-item' ||
    pathname === '/accounting/reports/purchases-by-item' ||
    pathname === '/accounting/reports/item-movement' ||
    pathname === '/accounting/reports/item-valuation' ||
    pathname === '/accounting/reports/item-quantities'
  ) {
    return 'inventory';
  }

  // ── Banking ─────────────────────────────────────────────────────────────
  if (pathname.startsWith('/accounting/bank-')) return 'banking';

  // ── Tax (VAT + SARS + Payroll SARS submissions) ─────────────────────────
  if (
    pathname.startsWith('/accounting/vat-') ||
    pathname.startsWith('/accounting/drc-vat') ||
    pathname.startsWith('/accounting/sars') ||
    pathname === '/accounting/reports/vat-reconciliation' ||
    pathname.startsWith('/payroll/emp201') ||
    pathname.startsWith('/payroll/emp501') ||
    pathname.startsWith('/payroll/irp5') ||
    pathname.startsWith('/payroll/uif') ||
    pathname.startsWith('/payroll/tax-directives') ||
    pathname.startsWith('/payroll/year-end')
  ) {
    return 'tax';
  }

  // ── Accounting (CoA + GL + journals + periods + assets + management) ────
  if (
    pathname.startsWith('/accounting/chart-of-accounts') ||
    pathname.startsWith('/accounting/journal-entries') ||
    pathname.startsWith('/accounting/recurring-journals') ||
    pathname.startsWith('/accounting/auto-postings') ||
    pathname.startsWith('/accounting/fiscal-periods') ||
    pathname.startsWith('/accounting/financial-years') ||
    pathname.startsWith('/accounting/financial-year-end-change') ||
    pathname.startsWith('/accounting/year-end') ||
    pathname.startsWith('/accounting/default-accounts') ||
    pathname.startsWith('/accounting/merchant-categories') ||
    pathname.startsWith('/accounting/currencies') ||
    pathname.startsWith('/accounting/exchange-rates') ||
    pathname.startsWith('/accounting/settings/currencies') ||
    pathname.startsWith('/accounting/settings/exchange-rates') ||
    pathname.startsWith('/accounting/settings/account-reporting-groups') ||
    pathname.startsWith('/accounting/accounting-settings') ||
    pathname.startsWith('/accounting/opening-balances') ||
    pathname.startsWith('/accounting/audit-log') ||
    pathname.startsWith('/accounting/change-history') ||
    pathname.startsWith('/accounting/assets') ||
    pathname.startsWith('/accounting/depreciation') ||
    pathname.startsWith('/accounting/cost-centres') ||
    pathname.startsWith('/accounting/business-units') ||
    pathname.startsWith('/accounting/budgets')
  ) {
    return 'accounting';
  }

  // ── Reports (incl. AFS, Management Packs) ───────────────────────────────
  if (
    pathname.startsWith('/accounting/afs') ||
    pathname.startsWith('/accounting/trial-balance') ||
    pathname.startsWith('/accounting/reports')
  ) {
    return 'reports';
  }

  // ── Practice (firm tools: clients, jobs, time, WIP) ─────────────────────
  if (pathname.startsWith('/accounting/practice')) return 'practice';

  // ── Payroll (employees, runs, leave only — SARS bits live under Tax) ────
  if (pathname.startsWith('/payroll')) return 'payroll';

  return 'dashboard';
}

/** Modules with their own top tab and hover menu. */
export const PROMOTED_MODULE_IDS: ReadonlySet<string> = new Set([
  'sales', 'purchases', 'payroll', 'tax', 'reports',
]);

/** Modules reachable only through the Library tab. */
export const LIBRARY_ONLY_IDS: ReadonlySet<string> = new Set([
  'inventory', 'accounting', 'practice',
]);

/** Top-bar resolver: promoted modules keep their id; library-only modules collapse onto Library. */
export function getActiveTabId(
  pathname: string,
  query: Record<string, string | string[] | undefined>,
): string {
  if (pathname.startsWith('/accounting/library')) return 'library';
  if (pathname.startsWith('/accounting/portfolio-workbench')) return 'portfolio';
  if (pathname.startsWith('/accounting/month-end-workbench')) return 'workbench';
  const id = getActiveModuleId(pathname, query);
  return LIBRARY_ONLY_IDS.has(id) ? 'library' : id;
}

/**
 * Does a nav link `href` own the page at `asPath`?
 *
 * - `#fragment` is ignored on both sides, then the query is split off.
 * - The path matches itself or a child on a segment boundary, so `/a/b`
 *   claims `/a/b/c` but not `/a/bc`.
 * - The href's query must be a SUBSET of the page's, compared as parsed
 *   params (`tab=general` does not match `tab=generalx`).
 */
export function pathMatchesHref(href: string, asPath: string): boolean {
  const [hrefPath, hrefQuery] = splitHref(href);
  const [pagePath, pageQuery] = splitHref(asPath);
  const itemPath = hrefPath.length > 1 ? hrefPath.replace(/\/+$/, '') : hrefPath;
  if (pagePath !== itemPath && !pagePath.startsWith(`${itemPath}/`)) return false;
  if (!hrefQuery) return true;
  const want = new URLSearchParams(hrefQuery);
  const have = new URLSearchParams(pageQuery);
  for (const [key, value] of want) {
    if (!have.getAll(key).includes(value)) return false;
  }
  return true;
}

function splitHref(url: string): [string, string] {
  const noFragment = url.split('#')[0] as string;
  const q = noFragment.indexOf('?');
  return q === -1 ? [noFragment, ''] : [noFragment.slice(0, q), noFragment.slice(q + 1)];
}

/**
 * Links that own only their exact path: matching every sub-path would claim unrelated pages (/accounting is the
 * Dashboard; /accounting/sars is the calendar, and its sub-pages are other links or, for a non-vendor, hidden ones).
 * Shared by the menu highlight and navIndex so the two cannot disagree.
 */
export const EXACT_ONLY_PATHS: ReadonlySet<string> = new Set(['/accounting', '/accounting/sars']);

/**
 * Of a set of sibling links, the one that is active for `asPath`: the longest
 * matching path wins, so /bank-reconciliation/import lights only "Import
 * Statement", not "Reconcile" as well. Null when none match.
 */
export function mostSpecificActiveHref(hrefs: string[], asPath: string): string | null {
  let best: string | null = null;
  let bestScore: [number, number] = [-1, -1];
  const [pagePath] = splitHref(asPath);
  for (const href of hrefs) {
    if (!pathMatchesHref(href, asPath)) continue;
    const [itemPath, qs] = splitHref(href);
    if (EXACT_ONLY_PATHS.has(itemPath) && pagePath !== itemPath) continue;
    // More path segments win; among equals the longer query wins. A link with
    // no query scores 0, so any `?tab=` link on the same path beats it.
    const score: [number, number] = [itemPath.split('/').length, qs.length];
    if (score[0] > bestScore[0] || (score[0] === bestScore[0] && score[1] > bestScore[1])) {
      best = href;
      bestScore = score;
    }
  }
  return best;
}

/** `mostSpecificActiveHref` over the plain links of a mixed link/section list. */
export function activeHrefAmong(items: Array<{ href: string } | { section: string }>, asPath: string): string | null {
  const hrefs = items.flatMap(i => ('href' in i ? [i.href] : []));
  return mostSpecificActiveHref(hrefs, asPath);
}

export function isLinkActive(href: string, asPath: string): boolean {
  return pathMatchesHref(href, asPath);
}
