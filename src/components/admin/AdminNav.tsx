/**
 * Admin sidebar navigation component.
 * Vertically stacked links with active state highlighting.
 */

import Link from 'next/link';
import { useRouter } from 'next/router';
import {
  LayoutDashboard,
  Building2,
  Users,
  CreditCard,
  Wrench,
  ScrollText,
  Settings,
  ChevronRight,
  List,
  FileText,
  Megaphone,
} from 'lucide-react';

interface NavItem {
  label: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  disabled?: boolean;
  children?: { label: string; href: string; icon: React.ComponentType<{ className?: string }> }[];
}

const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard',   href: '/admin',           icon: LayoutDashboard },
  { label: 'Companies',   href: '/admin/companies', icon: Building2 },
  { label: 'Users',       href: '/admin/users',     icon: Users },
  {
    label: 'Billing',
    href: '/admin/billing',
    icon: CreditCard,
    children: [
      { label: 'Overview',      href: '/admin/billing',               icon: CreditCard },
      { label: 'Plans',         href: '/admin/billing/plans',         icon: CreditCard },
      { label: 'Subscriptions', href: '/admin/billing/subscriptions', icon: List },
      { label: 'Invoices',      href: '/admin/billing/invoices',      icon: FileText },
    ],
  },
  {
    label: 'Tools',
    href: '/admin/tools',
    icon: Wrench,
    children: [
      { label: 'Overview',       href: '/admin/tools',               icon: Wrench },
      { label: 'Announcements',  href: '/admin/tools/announcements', icon: Megaphone },
    ],
  },
  { label: 'Audit Trail', href: '/admin/audit',     icon: ScrollText },
  { label: 'Settings',    href: '/admin/settings',  icon: Settings,   disabled: true },
];

export function AdminNav() {
  const router = useRouter();

  const isActive = (href: string) => {
    if (href === '/admin') return router.pathname === '/admin';
    return router.pathname.startsWith(href);
  };

  const isBillingOpen = router.pathname.startsWith('/admin/billing');
  const isToolsOpen   = router.pathname.startsWith('/admin/tools');
  const isSectionOpen = (href: string) => {
    if (href === '/admin/billing') return isBillingOpen;
    if (href === '/admin/tools')   return isToolsOpen;
    return router.pathname.startsWith(href);
  };

  return (
    <aside className="w-56 flex-shrink-0 bg-gray-900 border-r border-gray-700 flex flex-col min-h-full">
      <div className="px-4 py-4 border-b border-gray-700">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Admin Console</p>
      </div>
      <nav className="flex-1 py-3 px-2 space-y-0.5">
        {NAV_ITEMS.map(item => {
          const Icon = item.icon;

          if (item.disabled) {
            return (
              <div
                key={item.href}
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
            const parentActive = isActive(item.href);
            return (
              <div key={item.href}>
                {/* Parent link */}
                <Link
                  href={item.href}
                  className={[
                    'flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors',
                    parentActive
                      ? 'bg-teal-600 text-white font-medium'
                      : 'text-gray-300 hover:bg-gray-700/60 hover:text-white',
                  ].join(' ')}
                >
                  <Icon className="w-4 h-4 flex-shrink-0" />
                  <span>{item.label}</span>
                  <ChevronRight className={`w-3.5 h-3.5 ml-auto transition-transform ${isSectionOpen(item.href) ? 'rotate-90' : ''}`} />
                </Link>

                {/* Sub-links — visible when parent section is active */}
                {isSectionOpen(item.href) && (
                  <div className="ml-3 mt-0.5 space-y-0.5 border-l border-gray-700 pl-3">
                    {item.children.map(child => {
                      const ChildIcon = child.icon;
                      const childActive = router.pathname === child.href;
                      return (
                        <Link
                          key={child.href}
                          href={child.href}
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

          const active = isActive(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
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
