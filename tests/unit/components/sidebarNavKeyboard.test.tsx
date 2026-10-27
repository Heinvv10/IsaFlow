/**
 * The desktop sidebar (sidebar nav mode, lg up) works from the keyboard: ArrowRight opens a tab's flyout and focuses its
 * first entry, arrows move inside it, a section row opens its sub-panel the same way, ArrowLeft/Escape step back, and
 * Escape on the tab's flyout closes it with focus returned to the row.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

vi.mock('next/router', () => ({ useRouter: () => ({ pathname: '/accounting', asPath: '/accounting', query: {} }) }));
vi.mock('@/hooks/useVatRegistration', () => ({ useVatRegistration: () => ({ isRegistered: true, known: true }) }));

import { SidebarNav } from '@/components/layout/SidebarNav';

afterEach(cleanup);

const active = () => document.activeElement as HTMLElement;

describe('SidebarNav from the keyboard', () => {
  it('every tab row is in the tab order, including those without a page of their own', () => {
    render(<SidebarNav />);
    for (const row of screen.getAllByTestId(/^sidebar-tab-/)) {
      expect(row.tagName === 'A' || row.getAttribute('tabindex') === '0').toBe(true);
    }
  });

  it('ArrowRight opens the Sales flyout and focuses its first entry; Escape closes it and refocuses the row', () => {
    render(<SidebarNav />);
    const sales = screen.getByTestId('sidebar-tab-sales');
    sales.focus();
    fireEvent.keyDown(sales, { key: 'ArrowRight' });
    expect(sales.getAttribute('aria-expanded')).toBe('true');
    expect(active().textContent).toBe('Invoices');
    fireEvent.keyDown(active(), { key: 'ArrowDown' });
    expect(active().textContent).toBe('Quotes');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText('Quotes')).toBeNull();
    expect(active()).toBe(sales);
  });

  it('a section row opens its sub-panel with Enter and ArrowLeft returns to the row', () => {
    render(<SidebarNav />);
    const sales = screen.getByTestId('sidebar-tab-sales');
    fireEvent.keyDown(sales, { key: 'ArrowRight' });
    const transactions = screen.getByRole('button', { name: 'Transactions' });
    expect(transactions.getAttribute('tabindex')).toBe('0'); // in the tab order, not only programmatically focusable
    transactions.focus();
    fireEvent.keyDown(transactions, { key: 'Enter' });
    expect(transactions.getAttribute('aria-expanded')).toBe('true');
    expect(active().textContent).toBe('Quotes');
    expect(screen.getByRole('link', { name: 'Sales Orders' })).toBeTruthy();
    fireEvent.keyDown(active(), { key: 'ArrowLeft' });
    expect(screen.queryByRole('link', { name: 'Sales Orders' })).toBeNull();
    expect(active()).toBe(transactions);
  });
});
