/**
 * The secondary nav marks the ITEM inside an open dropdown from the same path it marks the section from: on a management
 * pack's page (same URL as an AFS document) the page's navPath lights "Pack Documents", where the router's path alone
 * lights nothing in that menu.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

const route = vi.hoisted(() => ({ asPath: '/accounting/afs/ba60eeb5' }));
vi.mock('next/router', () => ({ useRouter: () => ({ asPath: route.asPath, pathname: '/accounting/afs/[documentId]', query: {} }) }));
vi.mock('@/hooks/useVatRegistration', () => ({ useVatRegistration: () => ({ isRegistered: true, known: true }) }));

import { ModuleNav } from '@/components/layout/ModuleNav';
import { moduleSectionsToTabs } from '@/components/accounting/navSections/secondaryNav';
import { reportsTab } from '@/components/accounting/navSections/reports';

afterEach(() => { cleanup(); route.asPath = '/accounting/afs/ba60eeb5'; });
const tabs = moduleSectionsToTabs(reportsTab);

function openPacks(navPath?: string) {
  render(<ModuleNav tabs={tabs} getActiveTabId={() => 'Management Packs'} accentColor="slate" navPath={navPath} />);
  fireEvent.click(screen.getByRole('button', { name: /Management Packs/ }));
  const panel = document.querySelector('[data-nav-panel]') as HTMLElement;
  return { pack: within(panel).getByRole('link', { name: 'Pack Documents' }).className, other: within(panel).getByRole('link', { name: 'Portal Contacts' }).className };
}

const ACCENT = 'text-slate-700'; // the slate accent's active-link class (moduleNavAccent)

describe('ModuleNav item mark follows navPath', () => {
  it('on a pack page, "Pack Documents" is marked and its neighbours are not', () => {
    const { pack, other } = openPacks('/accounting/afs/ba60eeb5?type=management_pack');
    expect(pack).toContain(ACCENT);
    expect(other).not.toContain(ACCENT);
  });

  it('with no navPath the router path decides: nothing in the menu is marked on /accounting/afs/<id>', () => {
    const { pack, other } = openPacks();
    expect(pack).not.toContain(ACCENT);
    expect(other).not.toContain(ACCENT);
  });

  it('an AFS document opened at a ?type=management_pack URL: its explicit navPath keeps Pack Documents unmarked (the URL alone would mark it)', () => {
    route.asPath = '/accounting/afs/a1?type=management_pack';
    expect(openPacks().pack).toContain(ACCENT);                          // the router's path alone: wrongly marked
    cleanup();
    const { pack, other } = openPacks('/accounting/afs/a1');             // what the AFS branch now passes
    expect(pack).not.toContain(ACCENT);
    expect(other).not.toContain(ACCENT);
  });
});
