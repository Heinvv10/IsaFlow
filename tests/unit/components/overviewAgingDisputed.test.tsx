/**
 * The ageing donut's legend shows a Disputed segment when there is one, so the
 * legend sums to the Receivables tile and the report total; a zero Disputed
 * (AP has no disputes) stays out of the legend, a zero age bucket does not.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';

vi.mock('next/dynamic', () => ({ default: () => () => null }));

import { OverviewTables } from '@/components/accounting/dashboard/OverviewTables';
import { formatMoney } from '@/lib/money/formatMoney';

afterEach(() => { cleanup(); });

const LABELS = ['Current', '1–30 Days', '31–60 Days', '61–90 Days', '90+ Days', 'Disputed'];
const buckets = (values: number[]) => LABELS.map((name, i) => ({ name, value: values[i]! }));
const text = (n: number) => formatMoney(n).replace(/\s/g, ' ');

function card(title: string): HTMLElement {
  return screen.getByRole('heading', { name: title }).parentElement!;
}

describe('ageing legend', () => {
  it('lists Disputed with its amount when there is a dispute, and hides a zero Disputed', () => {
    render(<OverviewTables topCustomers={[]} topExpenses={[]}
      arAging={buckets([100, 0, 0, 0, 750, 250])} apAging={buckets([100, 0, 0, 0, 5, 0])} />);
    const ar = within(card('AR Aging'));
    expect(ar.getByText('Disputed')).toBeTruthy();
    expect(ar.getByText(text(250))).toBeTruthy();
    expect(ar.getByText('1–30 Days')).toBeTruthy();
    const ap = within(card('AP Aging'));
    expect(ap.queryByText('Disputed')).toBeNull();
    expect(ap.getByText('1–30 Days')).toBeTruthy();
  });

  it('a book that is all disputed still draws the donut', () => {
    render(<OverviewTables topCustomers={[]} topExpenses={[]}
      arAging={buckets([0, 0, 0, 0, 0, 250])} apAging={buckets([0, 0, 0, 0, 0, 0])} />);
    expect(within(card('AR Aging')).getByText('Disputed')).toBeTruthy();
    expect(screen.queryByText('No outstanding AR')).toBeNull();
  });
});
