/**
 * Nav fly-outs, top nav and sidebar: hover intent (a diagonal move toward the open sub-panel does not hand it to the
 * rows it crosses), panels placed inside the window, and keyboard focus that never scrolls the app shell.
 * happy-dom cannot lay out, so positions are stubbed and the browser checks live in the PR's evidence.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, within, act, cleanup } from '@testing-library/react';

vi.mock('next/router', () => ({ useRouter: () => ({ pathname: '/accounting', asPath: '/accounting', query: {} }) }));
vi.mock('@/hooks/useVatRegistration', () => ({ useVatRegistration: () => ({ isRegistered: true, known: true }) }));

import { ModuleNav } from '@/components/layout/ModuleNav';
import { SidebarNav } from '@/components/layout/SidebarNav';
import { TABS, getActiveTabId } from '@/components/accounting/accountingNavConfig';

const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

const sales = () => document.querySelector('[data-tour="nav-sales"]') as HTMLElement;
const row = (name: string) => within(sales()).getByRole('button', { name });
const expanded = (el: HTMLElement) => el.getAttribute('aria-expanded') === 'true';
const subPanel = (r: HTMLElement) => document.getElementById(r.getAttribute('aria-controls') as string) as HTMLElement;
const moves = (...pts: Array<[number, number]>) => pts.forEach(([x, y]) => fireEvent.mouseMove(document, { clientX: x, clientY: y }));

/** Top nav, Sales open, Customers' sub-panel open to the right of the rows (x 510..730, y 100..500). */
function topNavWithCustomersOpen() {
  render(<ModuleNav tabs={TABS} getActiveTabId={getActiveTabId} accentColor="teal" />);
  fireEvent.pointerEnter(sales(), { pointerType: 'mouse' });
  const customers = row('Customers');
  fireEvent.mouseEnter(customers);
  vi.spyOn(subPanel(customers), 'getBoundingClientRect').mockReturnValue(rect(510, 100, 220, 400));
  return customers;
}

describe('top nav hover intent', () => {
  it('a diagonal move toward the open sub-panel does not switch to the row it crosses', () => {
    vi.useFakeTimers();
    const customers = topNavWithCustomersOpen();
    moves([400, 120], [420, 150], [440, 180]);
    fireEvent.mouseLeave(customers);
    fireEvent.mouseEnter(row('Transactions'), { clientX: 440, clientY: 180 });
    expect(expanded(customers)).toBe(true);
    expect(expanded(row('Transactions'))).toBe(false);
    act(() => { vi.advanceTimersByTime(100); });
    expect(expanded(customers)).toBe(true);
    fireEvent.mouseEnter(subPanel(customers)); // the pointer arrives
    act(() => { vi.advanceTimersByTime(500); });
    expect(expanded(customers)).toBe(true);
    expect(within(sales()).getByRole('link', { name: 'Debtors Manager' })).toBeTruthy();
  });

  it('counts from where the pointer entered the open row, so a diagonal move straight from rest is recognised', () => {
    vi.useFakeTimers();
    render(<ModuleNav tabs={TABS} getActiveTabId={getActiveTabId} accentColor="teal" />);
    fireEvent.pointerEnter(sales(), { pointerType: 'mouse' });
    const customers = row('Customers');
    fireEvent.mouseEnter(customers, { clientX: 400, clientY: 120 }); // the pointer arrives and rests here
    vi.spyOn(subPanel(customers), 'getBoundingClientRect').mockReturnValue(rect(510, 100, 220, 400));
    moves([430, 165]); // the first move after the rest already lands on the next row
    fireEvent.mouseLeave(customers);
    fireEvent.mouseEnter(row('Transactions'), { clientX: 430, clientY: 165 });
    expect(expanded(customers)).toBe(true);
    expect(expanded(row('Transactions'))).toBe(false);
  });

  it('a pointer that stops on the crossed row gets that row after 150 ms', () => {
    vi.useFakeTimers();
    const customers = topNavWithCustomersOpen();
    moves([400, 120], [420, 150], [440, 180]);
    fireEvent.mouseLeave(customers);
    fireEvent.mouseEnter(row('Transactions'), { clientX: 440, clientY: 180 });
    act(() => { vi.advanceTimersByTime(140); });
    expect(expanded(row('Transactions'))).toBe(false);
    act(() => { vi.advanceTimersByTime(20); });
    expect(expanded(row('Transactions'))).toBe(true);
    expect(expanded(customers)).toBe(false);
  });

  it('a straight move down the rows switches at once', () => {
    vi.useFakeTimers();
    const customers = topNavWithCustomersOpen();
    moves([400, 120], [400, 150], [400, 180]);
    fireEvent.mouseLeave(customers);
    fireEvent.mouseEnter(row('Transactions'), { clientX: 400, clientY: 180 });
    expect(expanded(row('Transactions'))).toBe(true);
    expect(expanded(customers)).toBe(false);
  });

  it('the keyboard is not delayed: ArrowRight on another row opens it at once while a pointer switch waits', () => {
    vi.useFakeTimers();
    const customers = topNavWithCustomersOpen();
    moves([400, 120], [420, 150], [440, 180]);
    fireEvent.mouseEnter(row('Transactions'), { clientX: 440, clientY: 180 });
    const reports = row('Reports');
    fireEvent.keyDown(reports, { key: 'ArrowRight' });
    expect(expanded(reports)).toBe(true);
    expect(subPanel(reports).contains(document.activeElement)).toBe(true);
    act(() => { vi.advanceTimersByTime(500); });
    expect(expanded(reports)).toBe(true);
    expect(expanded(customers)).toBe(false);
  });

  it('a tap or click on the crossed row opens it at once', () => {
    vi.useFakeTimers();
    topNavWithCustomersOpen();
    moves([400, 120], [420, 150], [440, 180]);
    fireEvent.pointerDown(row('Transactions'), { pointerType: 'touch' });
    fireEvent.mouseEnter(row('Transactions'), { clientX: 440, clientY: 180 });
    fireEvent.click(row('Transactions'), { detail: 1 });
    expect(expanded(row('Transactions'))).toBe(true);
  });
});

describe('sidebar hover intent', () => {
  function sidebarWithCustomersOpen() {
    render(<SidebarNav />);
    fireEvent.mouseEnter(screen.getByTestId('sidebar-tab-sales'));
    const customers = screen.getByRole('button', { name: 'Customers' });
    fireEvent.mouseEnter(customers);
    const panels = document.querySelectorAll<HTMLElement>('[data-sidebar-flyout]');
    vi.spyOn(panels[panels.length - 1]!, 'getBoundingClientRect').mockReturnValue(rect(510, 100, 220, 400));
    return customers;
  }

  it('a diagonal move toward the open sub-panel keeps it; a straight move down switches at once', () => {
    vi.useFakeTimers();
    const customers = sidebarWithCustomersOpen();
    moves([400, 120], [420, 150], [440, 180]);
    fireEvent.mouseLeave(customers);
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Transactions' }), { clientX: 440, clientY: 180 });
    act(() => { vi.advanceTimersByTime(100); });
    expect(expanded(customers)).toBe(true);
    expect(expanded(screen.getByRole('button', { name: 'Transactions' }))).toBe(false);
    moves([440, 200], [440, 230], [440, 260]);
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Reports' }), { clientX: 440, clientY: 260 });
    expect(expanded(screen.getByRole('button', { name: 'Reports' }))).toBe(true);
    expect(expanded(customers)).toBe(false);
  });
});

describe('sidebar tab rows hover intent', () => {
  it('a diagonal move toward the open flyout does not hand it to the tab rows it crosses', () => {
    vi.useFakeTimers();
    render(<SidebarNav />);
    const tab = (id: string) => screen.getByTestId(`sidebar-tab-${id}`);
    fireEvent.mouseEnter(tab('sales'));
    vi.spyOn(document.querySelector<HTMLElement>('[data-sidebar-flyout]')!, 'getBoundingClientRect').mockReturnValue(rect(256, 100, 220, 500));
    moves([120, 120], [140, 150], [160, 180]);
    fireEvent.mouseLeave(tab('sales'));
    fireEvent.mouseEnter(tab('purchases'), { clientX: 160, clientY: 180 });
    act(() => { vi.advanceTimersByTime(100); });
    expect(expanded(tab('sales'))).toBe(true);
    fireEvent.mouseLeave(tab('purchases')); // still on its way: the close grace starts, the pending switch is dropped
    fireEvent.mouseEnter(document.querySelector<HTMLElement>('[data-sidebar-flyout]')!);
    act(() => { vi.advanceTimersByTime(500); });
    expect(expanded(tab('sales'))).toBe(true);
    expect(expanded(tab('purchases'))).toBe(false);
  });

  it('counts from where the pointer entered the open tab row, so a diagonal move straight from rest is recognised', () => {
    vi.useFakeTimers();
    render(<SidebarNav />);
    const tab = (id: string) => screen.getByTestId(`sidebar-tab-${id}`);
    fireEvent.mouseEnter(tab('sales'), { clientX: 120, clientY: 120 });
    vi.spyOn(document.querySelector<HTMLElement>('[data-sidebar-flyout]')!, 'getBoundingClientRect').mockReturnValue(rect(256, 100, 220, 500));
    moves([150, 165]);
    fireEvent.mouseLeave(tab('sales'));
    fireEvent.mouseEnter(tab('purchases'), { clientX: 150, clientY: 165 });
    expect(expanded(tab('sales'))).toBe(true);
    expect(expanded(tab('purchases'))).toBe(false);
  });

  it('a straight move down the tab rows switches at once', () => {
    vi.useFakeTimers();
    render(<SidebarNav />);
    const tab = (id: string) => screen.getByTestId(`sidebar-tab-${id}`);
    fireEvent.mouseEnter(tab('sales'));
    moves([120, 120], [120, 150], [120, 180]);
    fireEvent.mouseLeave(tab('sales'));
    fireEvent.mouseEnter(tab('purchases'), { clientX: 120, clientY: 180 });
    expect(expanded(tab('purchases'))).toBe(true);
    expect(expanded(tab('sales'))).toBe(false);
  });
});

describe('panels are placed inside the window', () => {
  // happy-dom's window is 1024 x 768. Every box sits at y 600; every panel's content is 500 px tall.
  function stubLayout() {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect(300, 600, 210, 40));
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
    const panel = (el: HTMLElement) => el.hasAttribute('data-nav-panel') || el.hasAttribute('data-sidebar-flyout');
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) { return panel(this) ? 500 : 0; });
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) { return panel(this) ? 220 : 0; });
    return proto;
  }

  it('top nav: a sub-panel that would pass the bottom moves up, fixed to the viewport', () => {
    stubLayout();
    render(<ModuleNav tabs={TABS} getActiveTabId={getActiveTabId} accentColor="teal" />);
    fireEvent.pointerEnter(sales(), { pointerType: 'mouse' });
    const customers = row('Customers');
    fireEvent.mouseEnter(customers);
    const s = subPanel(customers).style;
    expect(s.position).toBe('fixed');
    expect(s.top).toBe(`${768 - 8 - 500}px`);
    expect(s.left).toBe('510px');
  });

  it('top nav: a sub-panel with sections of its own opens left when its own sub-panels would not fit on the right', () => {
    stubLayout();
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue(rect(490, 200, 210, 40)); // rows end at x 700
    render(<ModuleNav tabs={TABS} getActiveTabId={getActiveTabId} accentColor="teal" />);
    fireEvent.pointerEnter(document.querySelector('[data-tour="nav-library"]') as HTMLElement, { pointerType: 'mouse' });
    const lib = within(document.querySelector('[data-tour="nav-library"]') as HTMLElement);
    const accounting = lib.getByRole('button', { name: 'Accounting' });
    fireEvent.mouseEnter(accounting);
    expect(subPanel(accounting).style.left).toBe(`${490 - 220}px`); // 700 + 2 x 220 passes 1024
    fireEvent.mouseEnter(within(subPanel(accounting)).getByRole('button', { name: 'General Ledger' }));
    const gl = within(subPanel(accounting)).getByRole('button', { name: 'General Ledger' });
    expect(subPanel(gl).style.left).toBe(`${490 - 220}px`); // its own sub-panel keeps going left (rects are stubbed alike)
  });

  it('top nav: a sub-panel of links only stays on the right while it fits there', () => {
    stubLayout();
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue(rect(490, 200, 210, 40));
    render(<ModuleNav tabs={TABS} getActiveTabId={getActiveTabId} accentColor="teal" />);
    fireEvent.pointerEnter(sales(), { pointerType: 'mouse' });
    const customers = row('Customers');
    fireEvent.mouseEnter(customers);
    expect(subPanel(customers).style.left).toBe('700px');
  });

  it('top nav: a tab menu taller than the room under its tab gets a max height and scrolls', () => {
    stubLayout();
    render(<ModuleNav tabs={TABS} getActiveTabId={getActiveTabId} accentColor="teal" />);
    fireEvent.pointerEnter(sales(), { pointerType: 'mouse' });
    const menu = document.querySelector<HTMLElement>('#nav-menu-sales [data-nav-panel]')!;
    expect(menu.style.top).toBe('640px');
    expect(menu.style.maxHeight).toBe(`${768 - 8 - 640}px`);
    expect(menu.style.overflowY).toBe('auto');
  });

  it('sidebar: the tab flyout and a section sub-panel move up to end 8px above the bottom', () => {
    stubLayout();
    render(<SidebarNav />);
    fireEvent.mouseEnter(screen.getByTestId('sidebar-tab-sales'));
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Customers' }));
    const panels = [...document.querySelectorAll<HTMLElement>('[data-sidebar-flyout]')];
    expect(panels).toHaveLength(2);
    for (const p of panels) expect(p.style.top).toBe(`${768 - 8 - 500}px`);
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
    fireEvent.pointerEnter(sales(), { pointerType: 'mouse' });
    expect(Number(z('Main'))).toBeGreaterThan(Number(z('Purchases sections')));
    fireEvent.pointerLeave(sales(), { pointerType: 'mouse' });
    act(() => { vi.advanceTimersByTime(200); });
    fireEvent.pointerEnter(document.querySelector('[data-tour="nav-s"]') as HTMLElement, { pointerType: 'mouse' });
    expect(Number(z('Purchases sections'))).toBeGreaterThan(Number(z('Main')));
  });
});

describe('a sub-panel follows its parent panel', () => {
  // The banner appearing moves the sidebar's tab row; its flyout is re-placed, and a section sub-panel inside that
  // flyout must follow, although nothing about its own row changed size (its row sits in the moved flyout).
  it('sidebar: when the tab flyout is re-placed, its open section sub-panel is re-placed after it', () => {
    let rowTop = 100;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const panel = this.closest<HTMLElement>('[data-sidebar-flyout]');
      if (panel && panel !== this) return rect(256, (parseFloat(panel.style.top) || 0) + 40, 220, 40);
      return rect(0, rowTop, 256, 36);
    });
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.hasAttribute('data-sidebar-flyout') ? 300 : 0; });
    render(<SidebarNav />);
    fireEvent.mouseEnter(screen.getByTestId('sidebar-tab-sales'));
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Customers' }));
    const [root, sub] = [...document.querySelectorAll<HTMLElement>('[data-sidebar-flyout]')];
    expect([root!.style.top, sub!.style.top]).toEqual(['100px', '140px']);
    rowTop = 137;
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect([root!.style.top, sub!.style.top]).toEqual(['137px', '177px']);
  });
});

describe('keyboard focus never scrolls the shell', () => {
  it('every focus move in the top nav passes preventScroll', () => {
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    render(<ModuleNav tabs={TABS} getActiveTabId={getActiveTabId} accentColor="teal" />);
    fireEvent.click(within(sales()).getByRole('button', { name: 'Sales menu' }), { detail: 0 });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'End' });
    const transactions = row('Transactions');
    fireEvent.keyDown(transactions, { key: 'ArrowRight' });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'End' });
    expect(document.activeElement?.textContent).toBe('Adjustments');
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
    expect(document.activeElement).toBe(transactions);
    fireEvent.keyDown(within(sales()).getByRole('link', { name: 'Invoices' }), { key: 'Escape' });
    expect(focus.mock.calls.length).toBeGreaterThanOrEqual(5);
    for (const call of focus.mock.calls) expect(call[0]).toEqual({ preventScroll: true });
  });

  it('every focus move in the sidebar flyouts passes preventScroll', () => {
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    render(<SidebarNav />);
    const tab = screen.getByTestId('sidebar-tab-sales');
    fireEvent.keyDown(tab, { key: 'ArrowRight' });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowUp' });
    const transactions = screen.getByRole('button', { name: 'Transactions' });
    fireEvent.keyDown(transactions, { key: 'Enter' });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowUp' });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowLeft' });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.activeElement).toBe(tab);
    expect(focus.mock.calls.length).toBeGreaterThanOrEqual(5);
    for (const call of focus.mock.calls) expect(call[0]).toEqual({ preventScroll: true });
  });

  it('focusing the last item of a tall panel scrolls that panel, not the shell', () => {
    render(<div data-app-shell style={{ overflow: 'hidden' }}><ModuleNav tabs={TABS} getActiveTabId={getActiveTabId} accentColor="teal" /></div>);
    fireEvent.click(within(sales()).getByRole('button', { name: 'Sales menu' }), { detail: 0 });
    const transactions = row('Transactions');
    fireEvent.keyDown(transactions, { key: 'ArrowRight' });
    const panel = subPanel(transactions);
    // The panel shows y 100..400 of a 900 px list; its last link sits at 860..896.
    Object.defineProperty(panel, 'scrollHeight', { configurable: true, value: 900 });
    Object.defineProperty(panel, 'clientHeight', { configurable: true, value: 300 });
    vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue(rect(510, 100, 220, 300));
    const last = within(panel).getByRole('link', { name: 'Adjustments' });
    vi.spyOn(last, 'getBoundingClientRect').mockReturnValue(rect(510, 860, 220, 36));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'End' });
    expect(document.activeElement).toBe(last);
    expect(panel.scrollTop).toBe(896 - 400);
    const shell = document.querySelector('[data-app-shell]') as HTMLElement;
    expect([shell.scrollTop, shell.scrollLeft]).toEqual([0, 0]);
  });
});
