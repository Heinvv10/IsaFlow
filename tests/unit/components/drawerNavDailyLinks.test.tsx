/**
 * The phone drawer shows every daily link of a module, in order, as the desktop menu does. Each daily link also sits in
 * one of the module's sections (Invoices -> Transactions > Tax Invoices, Customer List -> Customers > List of
 * Customers): the daily row is the one-tap shortcut, so a filter that hides "a daily link whose page a section lists"
 * would empty the block (measured at 390 px: every daily row of Sales, Purchases, Payroll and Banking has a section
 * twin). The real config and a synthetic one, so a filter cannot creep back in for one shape of config only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Tab } from '@/components/accounting/navSections/types';

const h = vi.hoisted(() => ({ tabs: null as Tab[] | null }));
vi.mock('next/router', () => ({ useRouter: () => ({ pathname: '/accounting', asPath: '/accounting', query: {} }) }));
vi.mock('@/hooks/useVatRegistration', () => ({ useVatRegistration: () => ({ isRegistered: true, known: true }) }));
vi.mock('@/components/accounting/accountingNavConfig', async (orig) => {
  const real = await orig<typeof import('@/components/accounting/accountingNavConfig')>();
  return { ...real, get TABS() { return h.tabs ?? real.TABS; } };
});

import { DrawerNav } from '@/components/layout/DrawerNav';
import { TABS } from '@/components/accounting/accountingNavConfig';

afterEach(() => { cleanup(); h.tabs = null; });

/** The rows directly under an opened module, above its section buttons: landing row, daily links, "+ " quick adds. */
function moduleRows(id: string, label: string): string[] {
  fireEvent.click(screen.getByRole('button', { name: label }));
  return [...document.getElementById(`drawer-nav-${id}`)!.querySelectorAll(':scope > a')].map((a) => a.textContent!.trim());
}

describe('drawer daily links', () => {
  it.each(TABS.filter((t) => t.links?.length).map((t) => [t.label, t] as const))('%s: every daily link, in order, as on desktop', (_label, tab) => {
    render(<DrawerNav />);
    const rows = moduleRows(tab.id, tab.label).filter((r) => !r.startsWith('+ ') && !r.endsWith(' home'));
    expect(rows).toEqual(tab.links!.map((l) => l.label));
  });

  it('a synthetic module: a daily link whose page (and even whose name) a section lists still shows; the landing row only when no daily link opens it', () => {
    h.tabs = [
      { id: 'things', label: 'Things', href: '/things', links: [{ label: 'Things', href: '/things' }, { label: 'Widgets', href: '/widgets' }],
        items: [{ section: 'Things', items: [{ label: 'Things', href: '/things' }, { label: 'Widgets', href: '/widgets' }] }] },
      { id: 'shelf', label: 'Shelf', href: '/shelf', links: [{ label: 'Boxes', href: '/boxes' }],
        items: [{ section: 'Boxes', items: [{ label: 'All Boxes', href: '/boxes' }] }] },
    ];
    render(<DrawerNav />);
    expect(moduleRows('things', 'Things')).toEqual(['Things', 'Widgets']);
    expect(moduleRows('shelf', 'Shelf')).toEqual(['Shelf home', 'Boxes']);
  });
});
