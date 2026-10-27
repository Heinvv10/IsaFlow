/**
 * List states: a true first run gets the signature empty state (steps + "Try the demo company");
 * a filtered-empty result only offers to clear the filters; loading is a skeleton, never a spinner.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Users } from 'lucide-react';

vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock('@/contexts/CompanyContext', () => ({
  useCompany: () => ({
    companies: [{ companyId: 'd', companyName: 'Sandbox', role: 'viewer', isDefault: false, isDemo: true }],
    activeCompany: { id: 'mine' },
    switchCompany: vi.fn(),
  }),
}));
vi.mock('@/utils/toast', () => ({ notify: { error: vi.fn() } }));

import { ListEmpty } from '@/components/ui/ListEmpty';
import { ListSkeleton } from '@/components/ui/ListSkeleton';

const firstRun = {
  icon: Users, title: 'No customers yet', description: 'Add one.',
  checklist: ['Add the customer', 'Invoice them'],
  primaryAction: { label: 'New Customer', href: '/accounting/customers/new' },
};
afterEach(() => cleanup());

describe('<ListEmpty>', () => {
  it('first run: title, checklist, first action and the demo offer', () => {
    render(<ListEmpty filtered={false} firstRun={firstRun} />);
    expect(screen.getByText('No customers yet')).toBeTruthy();
    expect(screen.getByText('Add the customer')).toBeTruthy();
    expect(screen.getByText('New Customer')).toBeTruthy();
    expect(screen.getByText('Try the demo company')).toBeTruthy();
  });
  it('filtered: says no results, offers Clear filters, and never offers the demo', () => {
    const clear = vi.fn();
    render(<ListEmpty filtered onClearFilters={clear} firstRun={firstRun} />);
    expect(screen.getByText('No results')).toBeTruthy();
    expect(screen.queryByText('No customers yet')).toBeNull();
    expect(screen.queryByText('Try the demo company')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(clear).toHaveBeenCalled();
  });
});

describe('<ListSkeleton>', () => {
  it('is a busy status region of shimmer rows with no spinner', () => {
    const { container } = render(<ListSkeleton label="Loading customers" />);
    const region = screen.getByRole('status', { name: 'Loading customers' });
    expect(region.getAttribute('aria-busy')).toBe('true');
    expect(container.querySelectorAll('.animate-shimmer').length).toBeGreaterThan(8);
    expect(container.querySelector('.animate-spin')).toBeNull();
  });
});
