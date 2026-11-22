/**
 * A `pending` tab (its nav answer still loading, `NAV_PENDING`) holds its place in the top bar and the sidebar: it is
 * laid out, invisible, hidden from assistive tech and offers no link, so the tabs after it do not move when it appears.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ModuleNav } from '@/components/layout/ModuleNav';
import { payrollTab } from '@/components/accounting/navSections/payroll';
import type { Tab } from '@/components/accounting/navSections/types';

vi.mock('next/router', () => ({ useRouter: () => ({ pathname: '/accounting', asPath: '/accounting', query: {}, events: { on: () => {}, off: () => {} } }) }));

afterEach(cleanup);

const tabs: Tab[] = [{ id: 'dashboard', label: 'Dashboard', href: '/accounting' }, { ...payrollTab, pending: true }, { id: 'tax', label: 'Tax', href: '/accounting/tax' }];

describe('ModuleNav, a pending tab', () => {
  it('holds its slot invisible, with no link or control, between the tabs around it', () => {
    const { container } = render(<ModuleNav tabs={tabs} getActiveTabId={() => 'dashboard'} accentColor="teal" ariaLabel="Main" />);
    const slot = screen.getByTestId('nav-pending-payroll');
    expect(slot.className).toContain('invisible');
    expect(slot.getAttribute('aria-hidden')).toBe('true');
    expect(slot.querySelector('a, button')).toBeNull();
    expect(container.querySelector('a[href^="/payroll"]')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Payroll' })).toBeNull();
    const row = [...slot.parentElement!.children];
    expect(row.indexOf(slot)).toBe(1);
  });
});
