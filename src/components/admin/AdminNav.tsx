/**
 * Admin sidebar navigation component.
 * Vertically stacked links with active state highlighting. The menu and what lights it live in adminNavConfig.ts
 * (shared with the hamburger drawer and Ctrl+K); useAdminHref makes the hrefs subdomain-aware.
 */

import Link from 'next/link';
import { useRouter } from 'next/router';
import { ChevronRight } from 'lucide-react';
import { useAdminHref } from '@/hooks/useAdminPrefix';
import { resolveAdminNav } from './adminNavConfig';

export function AdminNav() {
  const router = useRouter();
  const buildHref = useAdminHref();
  const items = resolveAdminNav(buildHref, router.asPath);

  return (
    <aside className="w-56 flex-shrink-0 bg-white dark:bg-gray-900 border-r border-gray-300 dark:border-gray-700 flex flex-col min-h-full">
      <div className="px-4 py-4 border-b border-gray-300 dark:border-gray-700">
        <p className="text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wider">Admin Console</p>
      </div>
      <nav className="flex-1 py-3 px-2 space-y-0.5">
        {items.map(item => {
          const Icon = item.icon;

          if (item.children) {
            return (
              <div key={item.href}>
                <Link
                  href={item.href}
                  className={[
                    'flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors',
                    item.active
                      ? 'bg-brand-600 text-white font-medium'
                      : 'text-gray-300 hover:bg-gray-700/60 hover:text-white',
                  ].join(' ')}
                >
                  <Icon className="w-4 h-4 flex-shrink-0" />
                  <span>{item.label}</span>
                  <ChevronRight className={`w-3.5 h-3.5 ml-auto transition-transform ${item.open ? 'rotate-90' : ''}`} />
                </Link>

                {item.open && (
                  <div className="ml-3 mt-0.5 space-y-0.5 border-l border-gray-300 dark:border-gray-700 pl-3">
                    {item.children.map(child => {
                      const ChildIcon = child.icon;
                      return (
                        <Link
                          key={child.href}
                          href={child.href}
                          aria-current={child.active ? 'page' : undefined}
                          className={[
                            'flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs transition-colors',
                            child.active
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

          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={item.active ? 'page' : undefined}
              className={[
                'flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors',
                item.active
                  ? 'bg-brand-600 text-white font-medium'
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
