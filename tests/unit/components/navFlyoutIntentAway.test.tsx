/**
 * Nav fly-outs, hover intent, the other half: a pointer that keeps MOVING but not toward any open panel gets the normal
 * timing. Only movement toward an open panel may hold a close or a row switch; movement alone must not.
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
/** 20 ms steps from (x, y), moving `dx`, `dy` each: up to and just past `ms`. */
const keepMoving = (x: number, y: number, dx: number, dy: number, ms: number) => {
  for (let t = 20, i = 1; t <= ms; t += 20, i++) { tick(20); moves([x + dx * i, y + dy * i]); }
};

/** Top nav, Sales open, Customers' sub-panel open to the right of the rows (x 510..730, y 100..500). */
function topNavWithCustomersOpen() {
  render(<ModuleNav tabs={TABS} getActiveTabId={getActiveTabId} accentColor="teal" />);
  fireEvent.pointerEnter(sales(), { pointerType: 'mouse' });
  const customers = row('Customers');
  fireEvent.mouseEnter(customers);
  vi.spyOn(subPanel(customers), 'getBoundingClientRect').mockReturnValue(rect(510, 100, 220, 400));
  return customers;
}

describe('a pointer that keeps moving, but not toward an open panel', () => {
  it('a section sub-panel still closes 150 ms after the pointer leaves its row', () => {
    vi.useFakeTimers();
    const customers = topNavWithCustomersOpen();
    moves([400, 120], [390, 125], [380, 130]);
    fireEvent.mouseLeave(customers);
    keepMoving(380, 130, -10, 5, 140); // left, away from the sub-panel on the right
    expect(expanded(customers)).toBe(true);
    keepMoving(240, 200, -10, 5, 40);
    expect(expanded(customers)).toBe(false);
  });

  it('the top-nav tab menu still closes 150 ms after the pointer leaves it', () => {
    vi.useFakeTimers();
    topNavWithCustomersOpen();
    moves([400, 120], [390, 125], [380, 130]);
    fireEvent.pointerLeave(sales(), { pointerType: 'mouse' });
    keepMoving(380, 130, -10, 5, 140);
    expect(within(sales()).queryByRole('link', { name: 'Quotes' })).not.toBeNull();
    keepMoving(240, 200, -10, 5, 40);
    expect(within(sales()).queryByRole('link', { name: 'Quotes' })).toBeNull();
  });

  it('the sidebar flyout still closes 180 ms after the pointer leaves its tab row', () => {
    vi.useFakeTimers();
    render(<SidebarNav />);
    const tab = screen.getByTestId('sidebar-tab-sales');
    fireEvent.mouseEnter(tab, { clientX: 120, clientY: 120 });
    vi.spyOn(sidebarPanels()[0]!, 'getBoundingClientRect').mockReturnValue(rect(256, 100, 220, 500));
    moves([110, 125], [100, 130]);
    fireEvent.mouseLeave(tab);
    keepMoving(100, 130, -4, 6, 160); // left and down, away from the flyout on the right
    expect(sidebarPanels()).toHaveLength(1);
    keepMoving(36, 226, -4, 6, 40);
    expect(sidebarPanels()).toHaveLength(0);
    expect(expanded(tab)).toBe(false);
  });

  it('a crossed row still takes over at 150 ms once the pointer turns away from the open sub-panel', () => {
    vi.useFakeTimers();
    const customers = topNavWithCustomersOpen();
    moves([400, 120], [420, 150], [440, 180]); // heading for the sub-panel: the switch waits
    fireEvent.mouseLeave(customers);
    fireEvent.mouseEnter(row('Transactions'), { clientX: 440, clientY: 180 });
    keepMoving(440, 180, -10, 0, 140); // then along the row, back to the left
    expect(expanded(row('Transactions'))).toBe(false);
    keepMoving(300, 180, -10, 0, 40);
    expect(expanded(row('Transactions'))).toBe(true);
    expect(expanded(customers)).toBe(false);
  });
});
