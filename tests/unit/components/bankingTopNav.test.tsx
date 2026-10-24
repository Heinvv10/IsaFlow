import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

vi.mock('next/router', () => ({
  useRouter: () => ({ pathname: '/accounting', asPath: '/accounting', query: {} }),
}));
vi.mock('@/hooks/useVatRegistration', () => ({
  useVatRegistration: () => ({ isRegistered: true, known: true }),
}));

import { ModuleNav } from '@/components/layout/ModuleNav';
import { SidebarNav } from '@/components/layout/SidebarNav';
import { TABS, getActiveTabId } from '@/components/accounting/accountingNavConfig';

const DAILY: Array<[string, string]> = [
  ['Transactions', '/accounting/bank-transactions'],
  ['Reconcile', '/accounting/bank-reconciliation'],
  ['Transfers', '/accounting/bank-transfers'],
  ['Import Statement', '/accounting/bank-reconciliation/import'],
];

describe('Banking top-nav dropdown', () => {
  it('offers the daily banking links directly, not only Banking Settings', () => {
    render(<ModuleNav tabs={TABS} getActiveTabId={getActiveTabId} accentColor="teal" />);
    const banking = document.querySelector('[data-tour="nav-banking"]') as HTMLElement;
    fireEvent.click(within(banking).getByRole('button', { name: /banking/i }));

    for (const [name, href] of DAILY) {
      expect(within(banking).getByRole('link', { name }).getAttribute('href')).toBe(href);
    }
    expect(within(banking).getByRole('link', { name: 'Banking Settings' })).toBeTruthy();
  });
});

describe('Banking sidebar flyout', () => {
  it('renders the daily links as plain links, not "+ " quick actions', () => {
    render(<SidebarNav />);
    const tab = screen.getByText('Banking');
    fireEvent.mouseEnter(tab.closest('div') as HTMLElement);

    for (const [name, href] of DAILY) {
      const link = screen.getByRole('link', { name });
      expect(link.getAttribute('href')).toBe(href);
      expect(link.textContent?.trim().startsWith('+')).toBe(false);
    }
  });
});
