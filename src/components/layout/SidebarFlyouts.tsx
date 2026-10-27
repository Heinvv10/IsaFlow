/**
 * The desktop sidebar's flyout panels (SidebarNav, sidebar nav mode, `lg` up): a tab's panel and its section
 * sub-panels, each a portal on document.body so nothing is clipped.
 *
 * Keyboard: a section row is a button (Enter, Space or ArrowRight opens its sub-panel and focuses the first entry;
 * ArrowLeft or Escape closes it and returns focus to the row). ArrowDown/ArrowUp move between a panel's entries.
 */
import { useState, useRef, useEffect, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { isFlyout, activeHrefAmong, type Tab, type NavItem } from '../accounting/accountingNavConfig';
import { NavLinksBlock } from './NavLinksBlock';

// ─── Shared styles ──────────────────────────────────────────────────────────

export const panelCls = 'bg-[var(--ff-canvas-mid)] border border-[var(--ff-canvas-border)] rounded-lg shadow-2xl min-w-[210px] py-1';

const linkCls = (active: boolean) =>
  `block px-4 py-1.5 text-sm whitespace-nowrap transition-colors ${
    active
      ? 'text-teal-700 dark:text-teal-300 bg-teal-500/[0.08] font-medium'
      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-white/5'
  }`;

/** The focusable entries of a panel, in order. */
export const panelEntries = (panel: HTMLElement | null) =>
  panel ? [...panel.querySelectorAll<HTMLElement>(':scope > a, :scope > div > [data-flyout-row], :scope > [data-flyout-row]')] : [];

/** ArrowDown / ArrowUp move focus between the entries of the panel the event happened in. */
export function moveInPanel(e: ReactKeyboardEvent<HTMLElement>) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const items = panelEntries(e.currentTarget);
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next = items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length];
  if (!next) return;
  e.preventDefault();
  e.stopPropagation();
  next.focus();
}

// ─── Recursive section flyout using portals ─────────────────────────────────

function SectionFlyout({ label, items, asPath, onNav }: { label: string; items: NavItem[]; asPath: string; onNav: () => void }) {
  const activeHref = activeHrefAmong(items, asPath);
  const [open, setOpen] = useState(false);
  const [subPos, setSubPos] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const row = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const focusOnOpen = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cl = () => { if (timer.current) clearTimeout(timer.current); };
  const dl = () => { timer.current = setTimeout(() => setOpen(false), 150); };
  useEffect(() => () => cl(), []);
  useEffect(() => {
    if (!open || !focusOnOpen.current) return;
    focusOnOpen.current = false;
    panelEntries(panel.current)[0]?.focus();
  }, [open, subPos]);

  const handleEnter = () => {
    cl();
    setOpen(true);
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect();
      setSubPos({ top: rect.top, left: rect.right });
    }
  };

  const onRowKey = (e: ReactKeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    e.stopPropagation();
    focusOnOpen.current = true;
    handleEnter();
  };

  const onPanelKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft' || e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      row.current?.focus();
      return;
    }
    moveInPanel(e);
  };

  return (
    <div ref={ref} onMouseEnter={handleEnter} onMouseLeave={dl}>
      <div
        ref={row}
        role="button"
        tabIndex={0}
        aria-haspopup="menu"
        aria-expanded={open}
        data-flyout-row=""
        onKeyDown={onRowKey}
        className={`flex items-center justify-between px-4 py-2 text-sm cursor-default transition-colors ${
          open
            ? 'bg-slate-100 dark:bg-white/10 text-slate-900 dark:text-slate-100'
            : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-white/5'
        }`}
      >
        <span className="font-medium">{label}</span>
        <ChevronRight className="h-3.5 w-3.5 ml-4 flex-shrink-0" />
      </div>

      {open && subPos && createPortal(
        <div
          ref={panel}
          style={{ position: 'fixed', top: subPos.top, left: subPos.left, zIndex: 99999 }}
          className={panelCls}
          onMouseEnter={cl}
          onMouseLeave={dl}
          onKeyDown={onPanelKey}
        >
          {items.map(item => {
            if (!isFlyout(item)) {
              return (
                <Link key={item.href} href={item.href} onClick={onNav} className={linkCls(item.href === activeHref)}>
                  {item.label}
                </Link>
              );
            }
            // Nested section → recurse
            return <SectionFlyout key={item.section} label={item.section} items={item.items} asPath={asPath} onNav={onNav} />;
          })}
        </div>,
        document.body
      )}
    </div>
  );
}

// ─── Tab flyout content ─────────────────────────────────────────────────────

export function TabFlyoutContent({ tab, asPath, onNav }: { tab: Tab; asPath: string; onNav: () => void }) {
  const hasSections = tab.items?.some(isFlyout) ?? false;
  const activeHref = activeHrefAmong(tab.items ?? [], asPath);

  return (
    <>
      {/* Plain navigation links */}
      <NavLinksBlock
        links={tab.links}
        tabItems={tab.items}
        asPath={asPath}
        onNav={onNav}
        linkClassName={linkCls}
        separatorClassName="border-t border-[var(--ff-canvas-border)] my-1"
      />

      {/* Quick actions */}
      {tab.topItems?.map(item => (
        <Link key={item.href} href={item.href} onClick={onNav}
          className="block px-4 py-2 text-sm text-teal-600 dark:text-teal-400 hover:bg-slate-100 dark:hover:bg-white/5 transition-colors whitespace-nowrap">
          + {item.label}
        </Link>
      ))}
      {tab.topItems && tab.topItems.length > 0 && <div className="border-t border-[var(--ff-canvas-border)] my-1" />}

      {/* Sections with sub-flyouts */}
      {hasSections && tab.items?.map(item => {
        if (!isFlyout(item)) {
          return <Link key={item.href} href={item.href} onClick={onNav} className={linkCls(item.href === activeHref)}>{item.label}</Link>;
        }
        return <SectionFlyout key={item.section} label={item.section} items={item.items} asPath={asPath} onNav={onNav} />;
      })}

      {/* Flat items */}
      {!hasSections && tab.items?.map(item => {
        if (isFlyout(item)) return null;
        return <Link key={item.href} href={item.href} onClick={onNav} className={linkCls(item.href === activeHref)}>{item.label}</Link>;
      })}
    </>
  );
}
