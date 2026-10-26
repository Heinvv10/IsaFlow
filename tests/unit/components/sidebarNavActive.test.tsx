import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

let asPath = '/accounting';
vi.mock('next/router', () => ({
  useRouter: () => ({ pathname: asPath.split('?')[0], asPath, query: {} }),
}));
let registered = true;
vi.mock('@/hooks/useVatRegistration', () => ({
  useVatRegistration: () => ({ isRegistered: registered, known: true }),
}));

import { SidebarNav } from '@/components/layout/SidebarNav';

afterEach(() => { asPath = '/accounting'; registered = true; });

const lit = (name: string) => screen.getAllByRole('link', { name })[0]!.className.includes('font-medium');

describe('SidebarNav flyout highlighting', () => {
  it('a direct link does not stay lit on a page a section row owns', () => {
    asPath = '/accounting/bank-reconciliation/rules';
    render(<SidebarNav />);
    fireEvent.mouseEnter(screen.getByTestId('sidebar-tab-banking'));
    expect(lit('Reconcile')).toBe(false);
  });

  it('a direct link is lit on its own page', () => {
    asPath = '/accounting/bank-reconciliation';
    render(<SidebarNav />);
    fireEvent.mouseEnter(screen.getByTestId('sidebar-tab-banking'));
    expect(lit('Reconcile')).toBe(true);
  });

  it('for a non-vendor, /accounting/sars/vat201 lights no Tax link', () => {
    registered = false;
    asPath = '/accounting/sars/vat201';
    render(<SidebarNav />);
    fireEvent.mouseEnter(screen.getByTestId('sidebar-tab-tax'));
    expect(lit('Compliance Calendar')).toBe(false);
  });
});
