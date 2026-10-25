import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

const PATH = '/accounting/bank-reconciliation/import';
vi.mock('next/router', () => ({
  useRouter: () => ({ pathname: PATH, asPath: PATH, query: {} }),
}));
vi.mock('@/hooks/useVatRegistration', () => ({
  useVatRegistration: () => ({ isRegistered: true, known: true }),
}));

import { ModuleNav } from '@/components/layout/ModuleNav';
import { SidebarNav } from '@/components/layout/SidebarNav';
import { TABS, getActiveTabId } from '@/components/accounting/accountingNavConfig';

// The section row is a <span>; the plain "Transactions" link is an <a>.
const sectionRow = (root: HTMLElement) =>
  within(root).getAllByText('Transactions').find(el => el.tagName === 'SPAN')!.parentElement!;

describe('Transactions section flyout rows', () => {
  it('top nav highlights only the most specific row on /bank-reconciliation/import', () => {
    render(<ModuleNav tabs={TABS} getActiveTabId={getActiveTabId} accentColor="teal" />);
    const banking = document.querySelector('[data-tour="nav-banking"]') as HTMLElement;
    fireEvent.click(within(banking).getByRole('button', { name: /banking/i }));
    fireEvent.mouseEnter(sectionRow(banking));

    const section = within(banking).getAllByRole('link', { name: 'Import Statement' });
    const row = section[section.length - 1]!;
    expect(row.className).toContain('text-teal-400');
    const reconcile = within(banking).getAllByRole('link', { name: 'Reconcile' });
    for (const r of reconcile) expect(r.className).not.toContain('text-teal-400');
  });

  it('sidebar highlights only the most specific row', () => {
    render(<SidebarNav />);
    fireEvent.mouseEnter(screen.getByTestId('sidebar-tab-banking'));
    fireEvent.mouseEnter(sectionRow(document.body));
    // sidebar sub-flyouts position via getBoundingClientRect; happy-dom returns zeros, which still renders
    const imports = screen.getAllByRole('link', { name: 'Import Statement' });
    for (const l of imports) expect(l.className).toContain('font-medium');
    for (const l of screen.getAllByRole('link', { name: 'Reconcile' })) {
      expect(l.className).not.toContain('font-medium');
    }
  });
});
