import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

vi.mock('next/router', () => ({
  useRouter: () => ({ pathname: '/accounting', asPath: '/accounting', query: {} }),
}));

import { ModuleNav } from '@/components/layout/ModuleNav';
import { TABS, getActiveTabId } from '@/components/accounting/accountingNavConfig';

describe('Banking top-nav dropdown', () => {
  it('offers the daily banking links directly, not only Banking Settings', () => {
    render(<ModuleNav tabs={TABS} getActiveTabId={getActiveTabId} accentColor="teal" />);
    const banking = document.querySelector('[data-tour="nav-banking"]') as HTMLElement;
    fireEvent.click(within(banking).getByRole('button', { name: /banking/i }));

    const hrefOf = (name: string) =>
      within(banking).getByRole('link', { name }).getAttribute('href');
    expect(hrefOf('Bank Transactions')).toBe('/accounting/bank-transactions');
    expect(hrefOf('Bank Reconciliation')).toBe('/accounting/bank-reconciliation');
    expect(hrefOf('Transfers')).toBe('/accounting/bank-transfers');
    expect(screen.getByRole('link', { name: 'Banking Settings' })).toBeTruthy();
  });
});
