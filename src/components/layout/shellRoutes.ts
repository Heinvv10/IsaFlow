/**
 * Route-derived pieces of the app shell. Pure, so they are unit-tested apart from AppLayout.
 */
import { trailForPath, type NavIndexEntry } from '@/components/accounting/navSections/navIndex';

const PRODUCT = 'IsaFlow';

/**
 * "Tax Invoices · Sales · IsaFlow": the page, its module, the product. A top-level tab has no module, a page the
 * nav does not reach is just "IsaFlow". Library-only pages are named after their module, not after "Library".
 */
export function documentTitle(asPath: string, index: NavIndexEntry[]): string {
  const entry = trailForPath(asPath, index);
  if (!entry) return PRODUCT;
  const module = entry.trail[0] === 'Library' ? entry.trail[1] : entry.trail[0];
  return [entry.label, module, PRODUCT].filter(Boolean).join(' · ');
}

/** The payroll area: `/payroll` and its sub-pages, never a sibling such as `/payroll-settings`. */
export function isPayrollPath(pathname: string): boolean {
  return pathname === '/payroll' || pathname.startsWith('/payroll/');
}
