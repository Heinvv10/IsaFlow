/**
 * Nav fly-outs, top nav and sidebar: keyboard focus never scrolls the app shell (every focus() passes preventScroll,
 * and a tall panel scrolls itself to reveal the focused item). happy-dom cannot lay out: the call contract is asserted
 * here, the real scroll offsets in the PR's browser evidence.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, within, cleanup } from '@testing-library/react';

vi.mock('next/router', () => ({ useRouter: () => ({ pathname: '/accounting', asPath: '/accounting', query: {} }) }));
vi.mock('@/hooks/useVatRegistration', () => ({ useVatRegistration: () => ({ isRegistered: true, known: true }) }));

import { ModuleNav } from '@/components/layout/ModuleNav';
import { SidebarNav } from '@/components/layout/SidebarNav';
import { TABS, getActiveTabId } from '@/components/accounting/accountingNavConfig';
import { rect, subPanel } from '../helpers/navFlyoutStubs';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const sales = () => document.querySelector('[data-tour="nav-sales"]') as HTMLElement;
const row = (name: string) => within(sales()).getByRole('button', { name });

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
