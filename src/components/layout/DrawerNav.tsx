/**
 * DrawerNav — the nav inside the hamburger drawer (below `lg`), built from the same TABS as the top nav.
 *
 * An accordion, not flyouts: a 256px drawer leaves no room for a panel to its right on a phone (SidebarNav's
 * portal flyouts opened at x 256-466 on a 390px screen), and hover flyouts are unreachable from the keyboard.
 * Every module and section is a button (Enter/Space toggles, aria-expanded), every page a link, all in tab order.
 */
import { useState, type ReactNode } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { ChevronDown } from 'lucide-react';
import { TABS, getActiveTabId, isFlyout, activeHrefAmong, mostSpecificActiveHref, type NavItem, type Tab } from '../accounting/accountingNavConfig';
import { stripVatNav } from '../accounting/navSections/vatNav';
import { NavLinksBlock } from './NavLinksBlock';
import { useVatRegistration } from '@/hooks/useVatRegistration';

const rowCls = (active: boolean, depth: number) =>
  `flex w-full items-center justify-between py-2 pr-4 text-sm text-left transition-colors ${depth === 0 ? 'pl-4 font-medium border-l-[3px]' : depth === 1 ? 'pl-7' : 'pl-10'} ${
    active
      ? 'text-teal-700 dark:text-teal-300 bg-teal-500/[0.08] border-teal-500 dark:border-teal-400'
      : 'text-ink-muted hover:text-ink hover:bg-slate-100 dark:hover:bg-white/5 border-transparent'
  }`;

const hrefsOf = (items: NavItem[]): string[] => items.flatMap(i => (isFlyout(i) ? hrefsOf(i.items) : [i.href]));

function Group({ id, label, depth, active, children }: { id: string; label: string; depth: number; active: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(active);
  return (
    <div>
      <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(o => !o)} className={rowCls(active && !open, depth)}>
        <span>{label}</span>
        <ChevronDown aria-hidden="true" className={`h-3.5 w-3.5 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <div id={id}>{children}</div>}
    </div>
  );
}

function Items({ items, asPath, depth, idPrefix }: { items: NavItem[]; asPath: string; depth: number; idPrefix: string }) {
  const activeHref = activeHrefAmong(items, asPath);
  return (
    <>
      {items.map(item => isFlyout(item) ? (
        <Group key={item.section} id={`${idPrefix}-${item.section.replace(/\W+/g, '-')}`} label={item.section} depth={depth}
          active={mostSpecificActiveHref(hrefsOf(item.items), asPath) !== null}>
          <Items items={item.items} asPath={asPath} depth={depth + 1} idPrefix={idPrefix} />
        </Group>
      ) : (
        <Link key={item.href} href={item.href} aria-current={item.href === activeHref ? 'page' : undefined} className={rowCls(item.href === activeHref, depth)}>
          {item.label}
        </Link>
      ))}
    </>
  );
}

function TabGroup({ tab, asPath, active }: { tab: Tab; asPath: string; active: boolean }) {
  const id = `drawer-nav-${tab.id}`;
  return (
    <Group id={id} label={tab.label} depth={0} active={active}>
      {tab.href && <Link href={tab.href} className={rowCls(asPath === tab.href, 1)}>{tab.label} home</Link>}
      <NavLinksBlock links={tab.links} tabItems={tab.items} asPath={asPath} onNav={() => undefined}
        linkClassName={a => rowCls(a, 1)} separatorClassName="border-t border-[var(--ff-canvas-border)] my-1 ml-7" />
      {tab.topItems?.map(item => (
        <Link key={item.href} href={item.href} className="block py-2 pl-7 pr-4 text-sm text-teal-700 dark:text-teal-300 hover:bg-slate-100 dark:hover:bg-white/5">
          + {item.label}
        </Link>
      ))}
      <Items items={tab.items ?? []} asPath={asPath} depth={1} idPrefix={id} />
    </Group>
  );
}

export function DrawerNav() {
  const router = useRouter();
  const { isRegistered } = useVatRegistration();
  const activeTabId = getActiveTabId(router.pathname, router.query);
  return (
    <nav aria-label="Main" className="flex-1 overflow-y-auto py-2">
      {stripVatNav(TABS, isRegistered).map(tab => tab.items?.length ? (
        <TabGroup key={tab.id} tab={tab} asPath={router.asPath} active={activeTabId === tab.id} />
      ) : tab.href ? (
        <Link key={tab.id} href={tab.href} aria-current={activeTabId === tab.id ? 'page' : undefined} className={rowCls(activeTabId === tab.id, 0)}>
          {tab.label}
        </Link>
      ) : null)}
    </nav>
  );
}
