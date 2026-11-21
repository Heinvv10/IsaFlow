// The Intercompany tab on the Bills status strip: its count of what needs a person, absent without a connection, current on the inbox page.
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusTabs } from '@/components/accounting/supplier-invoices/StatusTabs';

describe('the Intercompany tab on the Bills strip', () => {
  it('shows the count of what needs a person, and nothing when there is none', () => {
    const { rerender } = render(<StatusTabs active="all" counts={{}} onChange={() => undefined} intercompany={{ count: 3, active: false }} />);
    expect(screen.getByTestId('intercompany-tab')).toHaveAttribute('href', '/accounting/supplier-invoices/intercompany');
    expect(screen.getByTestId('intercompany-badge')).toHaveTextContent('3');
    rerender(<StatusTabs active="all" counts={{}} onChange={() => undefined} intercompany={{ count: 0, active: false }} />);
    expect(screen.queryByTestId('intercompany-badge')).toBeNull();
    expect(screen.getByTestId('intercompany-tab')).toBeInTheDocument();
  });

  it('is absent for a company with no intercompany connection', () => {
    render(<StatusTabs active="all" counts={{}} onChange={() => undefined} intercompany={null} />);
    expect(screen.queryByTestId('intercompany-tab')).toBeNull();
  });

  it('marks itself current on the inbox page, where no status tab is selected', () => {
    render(<StatusTabs active={null} counts={{}} onChange={() => undefined} intercompany={{ count: 0, active: true }} />);
    expect(screen.getByTestId('intercompany-tab')).toHaveAttribute('aria-current', 'page');
  });

  it('announces the count to a screen reader as text in the link, not as an aria-label on a bare span', () => {
    render(<StatusTabs active="all" counts={{}} onChange={() => undefined} intercompany={{ count: 3, active: false }} />);
    expect(screen.getByRole('link', { name: /Intercompany.*3 waiting/ })).toBe(screen.getByTestId('intercompany-tab'));
    expect(screen.getByTestId('intercompany-tab')).toHaveTextContent('(3 waiting)'); // real text, which every screen reader reads
    expect(screen.getByTestId('intercompany-badge')).toHaveAttribute('aria-hidden', 'true'); // the visual number is not read twice
  });
});
