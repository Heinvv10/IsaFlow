/**
 * Nav fly-outs, top nav and sidebar: every panel is placed inside the window (fixed), cascades on the side with room,
 * is re-placed on scroll, on an ancestor resize (a banner appearing) and when its parent panel or tab moves, and the
 * nav with an open menu stacks over the other nav bar. Rects are stubbed (tests/unit/helpers/navFlyoutStubs.ts).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, within, act, cleanup } from '@testing-library/react';

vi.mock('next/router', () => ({ useRouter: () => ({ pathname: '/accounting', asPath: '/accounting', query: {} }) }));
vi.mock('@/hooks/useVatRegistration', () => ({ useVatRegistration: () => ({ isRegistered: true, known: true }) }));

import { ModuleNav } from '@/components/layout/ModuleNav';
import { SidebarNav } from '@/components/layout/SidebarNav';
import { TABS, getActiveTabId } from '@/components/accounting/accountingNavConfig';
import { rect, subPanel, sidebarPanels, stubUniformLayout, stubPanelLayout, fakeResizeObserver } from '../helpers/navFlyoutStubs';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const tabEl = (id: string) => document.querySelector(`[data-tour="nav-${id}"]`) as HTMLElement;
const hoverTab = (id: string) => fireEvent.pointerEnter(tabEl(id), { pointerType: 'mouse' });
const row = (tab: string, name: string) => within(tabEl(tab)).getByRole('button', { name });
const topNav = () => render(<ModuleNav tabs={TABS} getActiveTabId={getActiveTabId} accentColor="teal" />);
const salesMenu = () => document.querySelector<HTMLElement>('#nav-menu-sales [data-nav-panel]')!;

describe('top nav placement', () => {
  it('a sub-panel that would pass the bottom moves up, fixed to the viewport, at its old width', () => {
    stubUniformLayout();
    topNav();
    hoverTab('sales');
    fireEvent.mouseEnter(row('sales', 'Customers'));
    const p = subPanel(row('sales', 'Customers'));
    expect([p.style.position, p.style.top, p.style.left]).toEqual(['fixed', `${768 - 8 - 500}px`, '510px']);
    // No layout engine here: the width rule is pinned as a class. w-min keeps the min-content width the panel had as
    // an absolute child of its row; without it a fixed panel takes the room to the window's edge and its rows unwrap.
    expect(p.className).toContain('w-min');
    expect(p.className).toContain('rounded-r-lg');
  });

  it('a sub-panel with sections of its own opens left when its own sub-panels would not fit on the right', () => {
    stubUniformLayout(rect(490, 200, 210, 40)); // rows end at x 700: 700 + 2 x 220 passes 1024
    topNav();
    hoverTab('library');
    fireEvent.mouseEnter(row('library', 'Accounting'));
    const level2 = subPanel(row('library', 'Accounting'));
    expect(level2.style.left).toBe(`${490 - 220}px`);
    expect(level2.className).toContain('rounded-l-lg');
    const gl = within(level2).getByRole('button', { name: 'General Ledger' });
    fireEvent.mouseEnter(gl);
    expect(subPanel(gl).style.left).toBe(`${490 - 220}px`); // keeps going left
  });

  it('a sub-panel of links only stays on the right while it fits there', () => {
    stubUniformLayout(rect(490, 200, 210, 40));
    topNav();
    hoverTab('sales');
    fireEvent.mouseEnter(row('sales', 'Customers'));
    expect(subPanel(row('sales', 'Customers')).style.left).toBe('700px');
  });

  it('a tab menu taller than the room under its tab gets a max height and scrolls', () => {
    stubUniformLayout();
    topNav();
    hoverTab('sales');
    expect([salesMenu().style.top, salesMenu().style.maxHeight, salesMenu().style.overflowY]).toEqual(['640px', `${768 - 8 - 640}px`, 'auto']);
    expect(salesMenu().className).toContain('w-min');
  });

  it('a flat tab menu near the right edge is pulled back inside, under its tab', () => {
    stubUniformLayout(rect(950, 96, 60, 40), 220, 100);
    render(<ModuleNav tabs={[{ id: 'm', label: 'Menu', items: [{ label: 'One', href: '/one' }] }]} getActiveTabId={() => 'm'} accentColor="teal" />);
    hoverTab('m');
    const menu = document.getElementById('nav-menu-m') as HTMLElement;
    expect([menu.style.position, menu.style.top, menu.style.left]).toEqual(['fixed', '136px', `${1024 - 8 - 220}px`]);
    expect(menu.className).toContain('w-min');
  });

  it('is re-placed when anything scrolls (a scrolling parent panel moves its row)', () => {
    let tabTop = 96;
    stubPanelLayout(() => rect(100, tabTop, 80, 40));
    topNav();
    hoverTab('sales');
    expect(salesMenu().style.top).toBe('136px');
    tabTop = 60;
    act(() => { document.body.dispatchEvent(new Event('scroll')); });
    expect(salesMenu().style.top).toBe('100px');
  });

  it('is re-placed when an ancestor of its tab changes size (a banner appearing above the nav)', () => {
    const ro = fakeResizeObserver();
    let tabTop = 96;
    stubPanelLayout(() => rect(100, tabTop, 80, 40));
    render(<div data-testid="shell"><ModuleNav tabs={TABS} getActiveTabId={getActiveTabId} accentColor="teal" /></div>);
    hoverTab('sales');
    tabTop = 133;
    act(() => { ro.resize(screen.getByTestId('shell')); });
    expect(salesMenu().style.top).toBe('173px');
  });
});

describe('sidebar placement', () => {
  const tab = (id: string) => screen.getByTestId(`sidebar-tab-${id}`);
  const inPanel = (i: number, name: string) => within(sidebarPanels()[i]!).getByRole('button', { name });

  it('the tab flyout and a section sub-panel move up to end 8px above the bottom, at their old width', () => {
    stubUniformLayout();
    render(<SidebarNav />);
    fireEvent.mouseEnter(tab('sales'));
    fireEvent.mouseEnter(inPanel(0, 'Customers'));
    expect(sidebarPanels()).toHaveLength(2);
    for (const p of sidebarPanels()) {
      expect(p.style.top).toBe(`${768 - 8 - 500}px`);
      // w-max: the max-content width the panels had when they always opened at the sidebar's edge (see top nav test).
      expect(p.className).toContain('w-max');
    }
  });

  it('a section with sections of its own cascades left when the next level would not fit on the right', () => {
    stubPanelLayout(() => rect(300, 100, 200, 36)); // the tab row ends at x 500, every panel is 220 wide
    render(<SidebarNav />);
    fireEvent.mouseEnter(tab('library'));
    expect(sidebarPanels()[0]!.style.left).toBe('500px');
    fireEvent.mouseEnter(inPanel(0, 'Accounting')); // alone it fits right (720..940), with General Ledger it does not
    expect(sidebarPanels()[1]!.style.left).toBe('280px');
    fireEvent.mouseEnter(inPanel(1, 'General Ledger')); // fits either side: keeps the cascade's direction
    expect(sidebarPanels()[2]!.style.left).toBe('60px');
  });

  it('a tab flyout that had to open left makes its sections try the left first', () => {
    const root = () => sidebarPanels()[0];
    stubPanelLayout(() => rect(780, 100, 200, 36), (p) => (p === root() ? 220 : 200));
    render(<SidebarNav />);
    fireEvent.mouseEnter(tab('sales'));
    expect(root()!.style.left).toBe('560px');
    fireEvent.mouseEnter(inPanel(0, 'Customers')); // 360 on the left and 780 on the right both fit
    expect(sidebarPanels()[1]!.style.left).toBe('360px');
  });

  it('moving to another tab re-places the flyout at that tab, with no resize or scroll', () => {
    stubPanelLayout((el) => rect(0, el.dataset.testid === 'sidebar-tab-purchases' ? 300 : 100, 256, 36));
    render(<SidebarNav />);
    fireEvent.mouseEnter(tab('sales'));
    expect(sidebarPanels()[0]!.style.top).toBe('100px');
    fireEvent.mouseEnter(tab('purchases'));
    expect(sidebarPanels()[0]!.style.top).toBe('300px');
  });

  it('when the tab flyout is re-placed, its open section sub-panel is re-placed after it', () => {
    let rowTop = 100;
    stubPanelLayout(() => rect(0, rowTop, 256, 36));
    render(<SidebarNav />);
    fireEvent.mouseEnter(tab('sales'));
    fireEvent.mouseEnter(inPanel(0, 'Customers'));
    const [root, sub] = sidebarPanels();
    expect([root!.style.top, sub!.style.top]).toEqual(['100px', '110px']);
    rowTop = 137;
    act(() => { window.dispatchEvent(new Event('resize')); }); // re-places the tab flyout only: its row moved
    expect([root!.style.top, sub!.style.top]).toEqual(['137px', '147px']);
  });

  it('closes the flyouts when the window shrinks below the desktop sidebar (the tab row no longer renders)', () => {
    render(<SidebarNav />);
    fireEvent.mouseEnter(tab('purchases'));
    expect(sidebarPanels()).toHaveLength(1);
    vi.spyOn(tab('purchases'), 'getClientRects').mockReturnValue([] as unknown as DOMRectList);
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(sidebarPanels()).toHaveLength(0);
  });
});

describe('the nav bar with an open menu stacks above the other bar', () => {
  // The main row and the section bar under it are sibling navs with the same z-index, so the later one (the section
  // bar) painted over the main row's open menu and hid its first link ("Invoices" under "Suppliers").
  it('opening a main-row menu lifts the main row over the section bar, and back when it closes', () => {
    vi.useFakeTimers();
    const sections = [{ id: 's', label: 'Suppliers', items: [{ label: 'List', href: '/l' }] }];
    render(<>
      <ModuleNav tabs={TABS} getActiveTabId={getActiveTabId} accentColor="teal" ariaLabel="Main" />
      <ModuleNav tabs={sections} getActiveTabId={() => 's'} accentColor="slate" ariaLabel="Purchases sections" />
    </>);
    const z = (name: string) => (screen.getByRole('navigation', { name }).className.match(/\bz-(\d+)\b/) ?? [])[1];
    expect([z('Main'), z('Purchases sections')]).toEqual(['30', '30']);
    hoverTab('sales');
    expect(Number(z('Main'))).toBeGreaterThan(Number(z('Purchases sections')));
    fireEvent.pointerLeave(tabEl('sales'), { pointerType: 'mouse' });
    act(() => { vi.advanceTimersByTime(200); });
    hoverTab('s');
    expect(Number(z('Purchases sections'))).toBeGreaterThan(Number(z('Main')));
  });
});
