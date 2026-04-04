/**
 * Admin sidebar navigation component.
 * Vertically stacked links with active state highlighting.
 * Uses useAdminPrefix hook for subdomain-aware navigation.
 */

import Link from 'next/link';
import { useRouter } from 'next/router';
import { useAdminHref } from '@/hooks/useAdminPrefix';
import {
  LayoutDashboard,
  Building2,
  Users,
  CreditCard,
  Wrench,
  ScrollText,
  Settings,
  BarChart2,
  ChevronRight,
  List,
  FileText,
  Megaphone,
  Palette,
  ToggleRight,
} from 'lucide-react';

interface NavDef {
  label: string;
  /** Relative path without /admin prefix, e.g. '' for dashboard, '/companies' etc. */
  path: string;
  icon: React.ComponentType<{ className?: string }>;
  disabled?: boolean;
  children?: { label: string; path: string; icon: React.ComponentType<{ className?: string }> }[];
}

/** Navigation definitions with relative paths — full hrefs built dynamically via useAdminHref */
const NAV_DEFS: NavDef[] = [
  { label: 'Dashboard',   path: '',                          icon: LayoutDashboard },
  { label: 'Companies',   path: '/companies',                icon: Building2 },
  { label: 'Users',       path: '/users',                    icon: Users },
  {
    label: 'Billing',
    path: '/billing',
    icon: CreditCard,
    children: [
      { label: 'Overview',      path: '/billing',               icon: CreditCard },
      { label: 'Plans',         path: '/billing/plans',         icon: CreditCard },
      { label: 'Subscriptions', path: '/billing/subscriptions', icon: List },
      { label: 'Invoices',      path: '/billing/invoices',      icon: FileText },
    ],
  },
  {
    label: 'Tools',
    path: '/tools',
    icon: Wrench,
    children: [
      { label: 'Overview',       path: '/tools',               icon: Wrench },
      { label: 'Announcements',  path: '/tools/announcements', icon: Megaphone },
    ],
  },
  { label: 'Features',    path: '/features',   icon: ToggleRight },
  { label: 'Audit Trail', path: '/audit',      icon: ScrollText },
  { label: 'Analytics',   path: '/analytics',  icon: BarChart2 },
  { label: 'Components',  path: '/components', icon: Palette },
  { label: 'Settings',    path: '/settings',   icon: Settings },
];

export function AdminNav() {
  const router = useRouter();
  const buildHref = useAdminHref();

  const isActive = (adminPath: string) => {
    const href = buildHref(`/admin${adminPath}`);
    if (adminPath === '') return router.asPath === href;
    return router.asPath.startsWith(href);
  };

  const isSectionOpen = (adminPath: string) => {
    const href = buildHref(`/admin${adminPath}`);
    return router.asPath.startsWith(href);
  };

  return (
    <aside className="w-56 flex-shrink-0 bg-gray-900 border-r border-gray-700 flex flex-col min-h-full">
      <div className="px-4 py-4 border-b border-gray-700">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Admin Console</p>
      </div>
      <nav className="flex-1 py-3 px-2 space-y-0.5">
        {NAV_DEFS.map(item => {
          const Icon = item.icon;
          const href = buildHref(`/admin${item.path}`);

          if (item.disabled) {
            return (
              <div
                key={item.path}
                className="flex items-center gap-3 px-3 py-2 rounded-lg text-gray-600 cursor-not-allowed select-none"
                title="Coming Soon"
              >
                <Icon className="w-4 h-4 flex-shrink-0" />
                <span className="text-sm">{item.label}</span>
                <span className="ml-auto text-xs text-gray-700 font-medium">Soon</span>
              </div>
            );
          }

          if (item.children) {
            const parentActive = isActive(item.path);
            return (
              <div key={item.path}>
                <Link
                  href={href}
                  className={[
                    'flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors',
                    parentActive
                      ? 'bg-teal-600 text-white font-medium'
                      : 'text-gray-300 hover:bg-gray-700/60 hover:text-white',
                  ].join(' ')}
                >
                  <Icon className="w-4 h-4 flex-shrink-0" />
                  <span>{item.label}</span>
                  <ChevronRight className={`w-3.5 h-3.5 ml-auto transition-transform ${isSectionOpen(item.path) ? 'rotate-90' : ''}`} />
                </Link>

                {isSectionOpen(item.path) && (
                  <div className="ml-3 mt-0.5 space-y-0.5 border-l border-gray-700 pl-3">
                    {item.children.map(child => {
                      const ChildIcon = child.icon;
                      const childHref = buildHref(`/admin${child.path}`);
                      const childActive = router.asPath === childHref;
                      return (
                        <Link
                          key={child.path}
                          href={childHref}
                          className={[
                            'flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs transition-colors',
                            childActive
                              ? 'bg-teal-600/80 text-white font-medium'
                              : 'text-gray-400 hover:bg-gray-700/50 hover:text-white',
                          ].join(' ')}
                        >
                          <ChildIcon className="w-3.5 h-3.5 flex-shrink-0" />
                          <span>{child.label}</span>
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          }

          const active = isActive(item.path);
          return (
            <Link
              key={item.path}
              href={href}
              className={[
                'flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors',
                active
                  ? 'bg-teal-600 text-white font-medium'
                  : 'text-gray-300 hover:bg-gray-700/60 hover:text-white',
              ].join(' ')}
            >
              <Icon className="w-4 h-4 flex-shrink-0" />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
