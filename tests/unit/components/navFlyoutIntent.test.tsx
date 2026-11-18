/**
 * Nav fly-outs, top nav and sidebar: hover intent. A move toward the open sub-panel does not hand it to the rows it
 * crosses, however slowly it goes; a straight move along the rows, a pointer that stops, the keyboard and a tap
 * switch as before.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, within, act, cleanup } from '@testing-library/react';

vi.mock('next/router', () => ({ useRouter: () => ({ pathname: '/accounting', asPath: '/accounting', query: {} }) }));
vi.mock('@/hooks/useVatRegistration', () => ({ useVatRegistration: () => ({ isRegistered: true, known: true }) }));

import { ModuleNav } from '@/components/layout/ModuleNav';
import { SidebarNav } from '@/components/layout/SidebarNav';
import { TABS, getActiveTabId } from '@/components/accounting/accountingNavConfig';
import { rect, expanded, subPanel, moves, sidebarPanels } from '../helpers/navFlyoutStubs';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

const sales = () => document.querySelector('[data-tour="nav-sales"]') as HTMLElement;
const row = (name: string) => within(sales()).getByRole('button', { name });
const tick = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

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
    tick(100);
    expect(expanded(customers)).toBe(true);
    fireEvent.mouseEnter(subPanel(customers)); // the pointer arrives
    tick(500);
    expect(expanded(customers)).toBe(true);
    expect(within(sales()).getByRole('link', { name: 'Debtors Manager' })).toBeTruthy();
  });

  it('a slow move that stays on a crossed row longer than 150 ms, still heading for the sub-panel, keeps it', () => {
    vi.useFakeTimers();
    const customers = topNavWithCustomersOpen();
    moves([400, 120], [404, 127], [408, 134]);
    fireEvent.mouseLeave(customers);
    fireEvent.mouseEnter(row('Transactions'), { clientX: 408, clientY: 134 });
    for (let i = 1; i <= 8; i++) { tick(40); moves([408 + 4 * i, 134 + 7 * i]); } // 320 ms on the row, still moving
    expect(expanded(customers)).toBe(true);
    expect(expanded(row('Transactions'))).toBe(false);
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
    tick(140);
    expect(expanded(row('Transactions'))).toBe(false);
    tick(20);
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

  it('a slow move off the last row through empty space toward the sub-panel keeps it and the menu open', () => {
    vi.useFakeTimers();
    const customers = topNavWithCustomersOpen();
    moves([400, 120], [404, 127], [408, 134]);
    fireEvent.mouseLeave(customers); // no row below: the pointer is outside every row and panel
    fireEvent.pointerLeave(sales(), { pointerType: 'mouse' });
    for (let i = 1; i <= 8; i++) { tick(40); moves([408 + 4 * i, 134 + 7 * i]); } // 320 ms on the way
    expect(expanded(customers)).toBe(true);
    fireEvent.pointerEnter(sales(), { pointerType: 'mouse' }); // arrives in the sub-panel, inside the tab's subtree
    fireEvent.mouseEnter(subPanel(customers));
    tick(500);
    expect(expanded(customers)).toBe(true);
  });

  it('a pointer leaving a row closes its sub-panel 150 ms later, not before', () => {
    vi.useFakeTimers();
    const customers = topNavWithCustomersOpen();
    fireEvent.mouseLeave(customers);
    tick(140);
    expect(expanded(customers)).toBe(true);
    tick(20);
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
    tick(500);
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

describe('sidebar section rows hover intent', () => {
  const btn = (name: string) => screen.getByRole('button', { name });
  function sidebarWithCustomersOpen() {
    render(<SidebarNav />);
    fireEvent.mouseEnter(screen.getByTestId('sidebar-tab-sales'));
    fireEvent.mouseEnter(btn('Customers'));
    vi.spyOn(sidebarPanels().pop()!, 'getBoundingClientRect').mockReturnValue(rect(510, 100, 220, 400));
    return btn('Customers');
  }

  it('a diagonal move toward the open sub-panel keeps it; a straight move down switches at once', () => {
    vi.useFakeTimers();
    const customers = sidebarWithCustomersOpen();
    moves([400, 120], [420, 150], [440, 180]);
    fireEvent.mouseLeave(customers);
    fireEvent.mouseEnter(btn('Transactions'), { clientX: 440, clientY: 180 });
    tick(100);
    expect(expanded(customers)).toBe(true);
    expect(expanded(btn('Transactions'))).toBe(false);
    moves([440, 200], [440, 230], [440, 260]);
    fireEvent.mouseEnter(btn('Reports'), { clientX: 440, clientY: 260 });
    expect(expanded(btn('Reports'))).toBe(true);
    expect(expanded(customers)).toBe(false);
  });

  it('a slow move that stays on a crossed row longer than 150 ms, still heading for the sub-panel, keeps it', () => {
    vi.useFakeTimers();
    const customers = sidebarWithCustomersOpen();
    moves([400, 120], [404, 127], [408, 134]);
    fireEvent.mouseLeave(customers);
    fireEvent.mouseEnter(btn('Transactions'), { clientX: 408, clientY: 134 });
    for (let i = 1; i <= 8; i++) { tick(40); moves([408 + 4 * i, 134 + 7 * i]); }
    expect(expanded(customers)).toBe(true);
    expect(expanded(btn('Transactions'))).toBe(false);
  });

  it('a slow move off the flyout through empty space toward the sub-panel keeps both open', () => {
    vi.useFakeTimers();
    const customers = sidebarWithCustomersOpen();
    moves([400, 120], [404, 127], [408, 134]);
    fireEvent.mouseLeave(customers);
    fireEvent.mouseLeave(sidebarPanels()[0]!);
    for (let i = 1; i <= 8; i++) { tick(40); moves([408 + 4 * i, 134 + 7 * i]); }
    expect(sidebarPanels()).toHaveLength(2);
    expect(expanded(customers)).toBe(true);
  });

  it('a tap on a section row opens it at once, even while a stale pointer path aims at the open sub-panel', () => {
    vi.useFakeTimers();
    sidebarWithCustomersOpen();
    moves([400, 120], [420, 150], [440, 180]);
    fireEvent.pointerDown(btn('Transactions'), { pointerType: 'touch' });
    fireEvent.mouseEnter(btn('Transactions'), { clientX: 440, clientY: 180 });
    fireEvent.click(btn('Transactions'));
    expect(expanded(btn('Transactions'))).toBe(true);
  });
});

describe('sidebar tab rows hover intent', () => {
  const tab = (id: string) => screen.getByTestId(`sidebar-tab-${id}`);
  function salesOpen(at?: { clientX: number; clientY: number }) {
    render(<SidebarNav />);
    fireEvent.mouseEnter(tab('sales'), at);
    vi.spyOn(sidebarPanels()[0]!, 'getBoundingClientRect').mockReturnValue(rect(256, 100, 220, 500));
  }

  it('a diagonal move toward the open flyout does not hand it to the tab rows it crosses', () => {
    vi.useFakeTimers();
    salesOpen();
    moves([120, 120], [140, 150], [160, 180]);
    fireEvent.mouseLeave(tab('sales'));
    fireEvent.mouseEnter(tab('purchases'), { clientX: 160, clientY: 180 });
    tick(100);
    expect(expanded(tab('sales'))).toBe(true);
    fireEvent.mouseLeave(tab('purchases')); // still on its way: the close grace starts, the pending switch is dropped
    fireEvent.mouseEnter(sidebarPanels()[0]!);
    tick(500);
    expect(expanded(tab('sales'))).toBe(true);
    expect(expanded(tab('purchases'))).toBe(false);
  });

  it('a slow move that stays on a crossed tab row longer than 150 ms, still heading for the flyout, keeps it', () => {
    vi.useFakeTimers();
    salesOpen();
    moves([120, 120], [124, 127], [128, 134]);
    fireEvent.mouseLeave(tab('sales'));
    fireEvent.mouseEnter(tab('purchases'), { clientX: 128, clientY: 134 });
    for (let i = 1; i <= 8; i++) { tick(40); moves([128 + 4 * i, 134 + 7 * i]); }
    expect(expanded(tab('sales'))).toBe(true);
    expect(expanded(tab('purchases'))).toBe(false);
  });

  it('counts from where the pointer entered the open tab row, so a diagonal move straight from rest is recognised', () => {
    vi.useFakeTimers();
    salesOpen({ clientX: 120, clientY: 120 });
    moves([150, 165]);
    fireEvent.mouseLeave(tab('sales'));
    fireEvent.mouseEnter(tab('purchases'), { clientX: 150, clientY: 165 });
    expect(expanded(tab('sales'))).toBe(true);
    expect(expanded(tab('purchases'))).toBe(false);
  });

  it('a straight move down the tab rows switches at once', () => {
    vi.useFakeTimers();
    salesOpen();
    moves([120, 120], [120, 150], [120, 180]);
    fireEvent.mouseLeave(tab('sales'));
    fireEvent.mouseEnter(tab('purchases'), { clientX: 120, clientY: 180 });
    expect(expanded(tab('purchases'))).toBe(true);
    expect(expanded(tab('sales'))).toBe(false);
  });
});
