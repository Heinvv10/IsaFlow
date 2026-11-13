/**
 * The dashboard's section bar is a row of plain buttons in a labelled nav, the
 * current one marked aria-current="page", not an ARIA tablist: two of its items
 * (Chart of Accounts, Fiscal Periods) open another page, and a tablist would
 * announce them as tabs with no panel behind them.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { FileText, BookOpen } from 'lucide-react';
import { DashboardHero } from '@/components/accounting/dashboard/DashboardHero';

const tabs = [
  { id: 'overview', label: 'Overview', icon: FileText },
  { id: 'chart-of-accounts', label: 'Chart of Accounts', icon: BookOpen },
];

describe('DashboardHero section bar', () => {
  it('marks the current section with aria-current and uses no tab roles', () => {
    const onTabChange = vi.fn();
    render(<DashboardHero companyName="Demo" tabs={tabs} activeTab="overview" onTabChange={onTabChange} />);
    const nav = screen.getByRole('navigation', { name: 'Dashboard sections' });
    expect(nav).toBeTruthy();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Overview' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: 'Chart of Accounts' }).hasAttribute('aria-current')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Chart of Accounts' }));
    expect(onTabChange).toHaveBeenCalledWith('chart-of-accounts');
  });
});
