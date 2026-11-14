/**
 * The admin console's menu, and which item a path lights. One list for the desktop AdminNav, the hamburger drawer
 * and the Ctrl+K page index on the admin host, so the three cannot disagree.
 *
 * Paths are relative to /admin ('' is the dashboard); `buildHref` from useAdminHref turns them into this host's URL.
 * A section is open, and its parent lit, when the page is the parent's path or any child's: Email Log (/email-log)
 * lives under Tools without sharing its prefix. Inside a section only the most specific matching child is lit.
 */
import type { ComponentType } from 'react';
import {
  LayoutDashboard, Building2, Users, CreditCard, Wrench, ScrollText, Settings, BarChart2, List, FileText,
  Megaphone, ToggleRight, Zap, Database, ArrowUpDown, Clock, Mail, Activity, Webhook, Receipt, UserPlus,
  Wallet, Package,
} from 'lucide-react';
import { mostSpecificActiveHref, pathMatchesHref } from '@/components/accounting/navSections/activeTab';
import type { NavIndexEntry } from '@/components/accounting/navSections/navIndex';

type Icon = ComponentType<{ className?: string }>;

export interface AdminNavLink {
  label: string;
  /** Relative path without the /admin prefix, e.g. '' for the dashboard, '/companies'. */
  path: string;
  icon: Icon;
}

export interface AdminNavDef extends AdminNavLink {
  children?: AdminNavLink[];
}

export const ADMIN_NAV: readonly AdminNavDef[] = [
  { label: 'Dashboard',   path: '',          icon: LayoutDashboard },
  { label: 'Health',      path: '/health',    icon: Activity },
  { label: 'Companies',   path: '/companies', icon: Building2 },
  { label: 'Users',       path: '/users',     icon: Users },
  {
    label: 'Billing',
    path: '/billing',
    icon: CreditCard,
    children: [
      { label: 'Overview',      path: '/billing',               icon: CreditCard },
      { label: 'Plans',         path: '/billing/plans',         icon: CreditCard },
      { label: 'Subscriptions', path: '/billing/subscriptions', icon: List },
      { label: 'Invoices',      path: '/billing/invoices',      icon: FileText },
      { label: 'PAYG Tenants',  path: '/billing/payg',          icon: Wallet },
      { label: 'Flow Bundles',  path: '/billing/flow-bundles',  icon: Package },
    ],
  },
  {
    label: 'Tools',
    path: '/tools',
    icon: Wrench,
    children: [
      { label: 'Overview',       path: '/tools',               icon: Wrench },
      { label: 'Announcements',  path: '/tools/announcements', icon: Megaphone },
      { label: 'Sage Import',    path: '/tools/sage-import',   icon: Database },
      { label: 'Migrations',     path: '/tools/migrations',    icon: ArrowUpDown },
      { label: 'Email Log',      path: '/email-log',           icon: Mail },
      { label: 'Webhooks',       path: '/webhooks',            icon: Webhook },
    ],
  },
  {
    label: 'Payroll',
    // Parent path mirrors the only existing child page; there is no /admin/payroll
    // index route, and Next prefetches the parent href on render which would 404.
    path: '/payroll/sars-codes',
    icon: Receipt,
    children: [
      { label: 'SARS Codes', path: '/payroll/sars-codes', icon: Receipt },
    ],
  },
  { label: 'Waitlist',    path: '/waitlist',  icon: UserPlus },
  { label: 'Trials',      path: '/trials',    icon: Clock },
  { label: 'Features',    path: '/features',  icon: ToggleRight },
  { label: 'Job Queue',   path: '/job-queue', icon: Zap },
  { label: 'Audit Trail', path: '/audit',     icon: ScrollText },
  {
    label: 'Analytics',
    path: '/analytics',
    icon: BarChart2,
    children: [
      { label: 'Business',    path: '/analytics',     icon: BarChart2 },
      { label: 'Web Traffic', path: '/web-analytics', icon: Activity },
    ],
  },
  // The developer showcase (/components) is deliberately not listed: the page stays, the production menu does not
  // offer it (admin audit 2026-11-14, item 4.16).
  { label: 'Settings',    path: '/settings',  icon: Settings },
];

export interface ResolvedAdminLink {
  label: string;
  href: string;
  icon: Icon;
  active: boolean;
}

export interface ResolvedAdminItem extends ResolvedAdminLink {
  /** Only for a section: whether its children show. */
  open: boolean;
  children?: ResolvedAdminLink[];
}

const pathOf = (asPath: string): string => asPath.split(/[?#]/)[0] ?? asPath;

/** The menu with this host's hrefs and what `asPath` lights. */
export function resolveAdminNav(buildHref: (path: string) => string, asPath: string): ResolvedAdminItem[] {
  return ADMIN_NAV.map(({ label, path, icon, children }) => {
    const href = buildHref(`/admin${path}`);
    if (!children) {
      // The dashboard's href is the host root, a prefix of every page: only the exact path lights it.
      const active = path === '' ? pathOf(asPath) === href : pathMatchesHref(href, asPath);
      return { label, href, icon, active, open: false };
    }
    const links = children.map(c => ({ label: c.label, icon: c.icon, href: buildHref(`/admin${c.path}`) }));
    const current = mostSpecificActiveHref(links.map(l => l.href), asPath);
    const open = current !== null || pathMatchesHref(href, asPath);
    return { label, href, icon, active: open, open, children: links.map(l => ({ ...l, active: l.href === current })) };
  });
}

/**
 * Every admin page as a command-palette entry. A section's own page ("Overview", "Business") also answers to the
 * section's name, so "billing" finds Billing > Overview first.
 */
export function adminPageIndex(buildHref: (path: string) => string): NavIndexEntry[] {
  return ADMIN_NAV.flatMap(({ label, path, children }): NavIndexEntry[] => {
    if (!children) return [{ href: buildHref(`/admin${path}`), label, trail: [] }];
    return children.map(c => ({
      href: buildHref(`/admin${c.path}`),
      label: c.label,
      trail: [label],
      ...(c.path === path && c.label !== label ? { aliases: [label] } : {}),
    }));
  });
}
