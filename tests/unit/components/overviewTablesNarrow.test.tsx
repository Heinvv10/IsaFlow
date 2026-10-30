/**
 * Home's two Top 5 tables are wider than a 390 px card: each sits in a labelled, focusable,
 * horizontally scrolling region (the card is overflow-hidden, so without one the Invoices and %
 * columns were cut off and unreachable), and an exact amount never wraps. happy-dom has no layout;
 * the golden at 390 (y7) measures the real thing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';

vi.mock('next/dynamic', () => ({ default: () => () => null }));

import { OverviewTables } from '@/components/accounting/dashboard/OverviewTables';
import { formatMoney } from '@/lib/money/formatMoney';

afterEach(cleanup);

const text = (n: number) => formatMoney(n).replace(/\s/g, ' ');
const render5 = () => render(<OverviewTables
  topCustomers={[{ name: 'A very long customer name (Pty) Ltd', revenue: 6376148.65, invoiceCount: 349 }]}
  topExpenses={[{ accountName: 'Cost of sales and other things', total: 2189056.28, percentOfExpenses: 61.5 }]}
  arAging={[]} apAging={[]} />);

describe('Top 5 tables at a narrow width', () => {
  it.each([['Top 5 Customers by Revenue, table', 'Invoices'], ['Top 5 Expense Categories, table', '%']])(
    '%s is a focusable scroll region holding every column', (name, lastColumn) => {
      render5();
      const region = screen.getByRole('region', { name });
      expect(region.getAttribute('tabindex')).toBe('0');
      expect(region.className).toContain('overflow-x-auto');
      expect(within(region).getByRole('columnheader', { name: lastColumn })).toBeTruthy();
    });

  it('an exact amount does not wrap, so it is never cut mid-figure', () => {
    render5();
    for (const amount of [6376148.65, 2189056.28]) {
      expect(screen.getByText(text(amount)).className).toContain('whitespace-nowrap');
    }
  });

  it('an empty table has no scroll region', () => {
    render(<OverviewTables topCustomers={[]} topExpenses={[]} arAging={[]} apAging={[]} />);
    expect(screen.queryByRole('region')).toBeNull();
  });
});
