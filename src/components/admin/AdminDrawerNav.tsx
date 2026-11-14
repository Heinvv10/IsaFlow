/**
 * The hamburger drawer's nav on the admin host: the admin console's menu (adminNavConfig.ts), not the accounting
 * tabs, whose /accounting/* links are 404s there. Sections are listed open: the console's menu is short enough,
 * and a section's own label is a heading, since its first child ("Overview") already links to the same page.
 */
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useAdminHref } from '@/hooks/useAdminPrefix';
import { resolveAdminNav } from './adminNavConfig';

const rowCls = (active: boolean, nested: boolean) =>
  `flex w-full items-center gap-3 py-2 pr-4 text-sm transition-colors border-l-[3px] ${nested ? 'pl-7' : 'pl-4 font-medium'} ${
    active
      ? 'text-teal-700 dark:text-teal-300 bg-teal-500/[0.08] border-teal-500 dark:border-teal-400'
      : 'text-ink-muted hover:text-ink hover:bg-slate-100 dark:hover:bg-white/5 border-transparent'
  }`;

export function AdminDrawerNav() {
  const router = useRouter();
  const buildHref = useAdminHref();
  return (
    <nav aria-label="Admin" className="flex-1 overflow-y-auto py-2">
      {resolveAdminNav(buildHref, router.asPath).map(item => {
        const Icon = item.icon;
        if (!item.children) {
          return (
            <Link key={item.href} href={item.href} aria-current={item.active ? 'page' : undefined} className={rowCls(item.active, false)}>
              <Icon className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
              {item.label}
            </Link>
          );
        }
        return (
          <div key={item.href} role="group" aria-label={item.label}>
            <p className="flex items-center gap-3 pl-4 pt-3 pb-1 text-xs font-semibold uppercase tracking-wider text-ink-muted border-l-[3px] border-transparent">
              <Icon className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
              {item.label}
            </p>
            {item.children.map(child => (
              <Link key={child.href} href={child.href} aria-current={child.active ? 'page' : undefined} className={rowCls(child.active, true)}>
                {child.label}
              </Link>
            ))}
          </div>
        );
      })}
    </nav>
  );
}
