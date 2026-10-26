/**
 * The hamburger drawer's nav is an accordion: every module and section is a focusable button that toggles with the
 * keyboard, so a section-only page (Sales > Transactions > Sales Orders) is reachable without hover or a flyout.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

const router = vi.hoisted(() => ({ pathname: '/accounting', asPath: '/accounting', query: {} }));
vi.mock('next/router', () => ({ useRouter: () => router }));
vi.mock('@/hooks/useVatRegistration', () => ({ useVatRegistration: () => ({ isRegistered: true, known: true }) }));

import { DrawerNav } from '@/components/layout/DrawerNav';

afterEach(() => { cleanup(); router.pathname = '/accounting'; router.asPath = '/accounting'; });

const button = (name: string) => screen.getByRole('button', { name });

describe('DrawerNav', () => {
  it('reaches a section-only page through buttons: Sales, then Transactions, then the link', () => {
    render(<DrawerNav />);
    expect(screen.queryByRole('link', { name: 'Sales Orders' })).toBeNull();
    const sales = button('Sales');
    expect(sales.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(sales);
    expect(sales.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(button('Transactions'));
    expect(screen.getByRole('link', { name: 'Sales Orders' }).getAttribute('href')).toBe('/accounting/customer-sales-orders');
  });

  it('every module with pages is a native button (Enter and Space toggle it) and collapses again', () => {
    render(<DrawerNav />);
    for (const name of ['Sales', 'Purchases', 'Banking', 'Payroll', 'Tax', 'Reports', 'Library']) {
      expect(button(name).tagName).toBe('BUTTON');
    }
    fireEvent.click(button('Banking'));
    fireEvent.click(button('Banking'));
    expect(button('Banking').getAttribute('aria-expanded')).toBe('false');
  });

  it('opens on the current module and section, with the current page marked', () => {
    router.pathname = '/accounting/customer-sales-orders';
    router.asPath = '/accounting/customer-sales-orders';
    render(<DrawerNav />);
    expect(button('Sales').getAttribute('aria-expanded')).toBe('true');
    expect(button('Transactions').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('link', { name: 'Sales Orders' }).getAttribute('aria-current')).toBe('page');
  });
});
