/**
 * Home tiles show the exact amount ("R 11 009 575.43"), never the compact
 * abbreviation ("R 11.0M"): a tile is a figure someone reconciles against the
 * report it summarises (principle 1, spec §4 H).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));

import { apiFetch } from '@/lib/apiFetch';
import { formatMoney } from '@/lib/money/formatMoney';
import { OverviewKpiCards } from '@/components/accounting/dashboard/OverviewKpiCards';
import { NeedsAttention } from '@/components/accounting/dashboard/NeedsAttention';
import type { HeadlineFigures } from '@/modules/accounting/services/reports/headlineFigures';

useApiJsonOverMock();
afterEach(() => { cleanup(); });

const BIG = 11009575.43;
const COMPACT = /\d\.\d\s?[MK]\b/;
/** formatMoney's text as getByText sees it: the matcher normalises the DOM's NBSP to a space. */
const exact = (n: number): string => formatMoney(n).replace(/\s/g, ' ');
/** The headline figures the KPI row reads (reports/headlineFigures). */
const headline = (over: Partial<HeadlineFigures> = {}): HeadlineFigures => ({
  asAt: '2026-11-12', monthStart: '2026-11-01',
  cash: 0, receivables: { total: 0, overdue: 0 }, payables: { total: 0, overdue: 0 },
  revenueMtd: 0, profitMtd: 0,
  draftInvoices: 0, draftBills: 0, draftJournals: 0, billsDueNext7Days: 0, billsOverdue: 0,
  ...over,
});

describe('dashboard tiles show exact amounts', () => {
  it('KPI row: Cash, Receivables, Payables, Profit this month, in that order, exact', () => {
    const { container } = render(<OverviewKpiCards headline={headline({
      cash: 1234567.89,
      receivables: { total: 10686885.43, overdue: 10500000.01 },
      payables: { total: 2345678.9, overdue: 45000.5 },
      profitMtd: 4321098.76,
      revenueMtd: BIG,
    })} />);
    const titles = Array.from(container.querySelectorAll('span.uppercase')).map((e) => e.textContent);
    expect(titles).toEqual(['Cash', 'Receivables', 'Payables', 'Profit this month']);
    expect(screen.getByText(exact(1234567.89))).toBeTruthy();
    expect(screen.getByText('Per the ledger')).toBeTruthy();
    expect(screen.getByText(exact(10686885.43))).toBeTruthy();
    expect(screen.getByText(`${exact(10500000.01)} overdue`)).toBeTruthy();
    expect(screen.getByText(exact(2345678.9))).toBeTruthy();
    expect(screen.getByText(`${exact(45000.5)} overdue`)).toBeTruthy();
    expect(screen.getByText(exact(4321098.76))).toBeTruthy();
    expect(screen.getByText(`Revenue ${exact(BIG)} this month`)).toBeTruthy();
    expect(screen.getByText('As at 12 Nov 2026. Posted entries only. Profit and revenue are for the month to date.')).toBeTruthy();
    expect(container.textContent).not.toMatch(COMPACT);
    expect(container.textContent).not.toMatch(/Days to Close|Net margin|vs prior period/);
  });

  it('Payables says "No overdue" when nothing is overdue; a loss is shown as a loss', () => {
    render(<OverviewKpiCards headline={headline({ payables: { total: 500, overdue: 0 }, profitMtd: -2189056.28 })} />);
    expect(screen.getAllByText('No overdue')).toHaveLength(2);
    const loss = screen.getByText(exact(-2189056.28));
    expect(loss.className).toMatch(/text-rose-600/);
  });

  it('Receivables shows the disputed share of the overdue figure, only when there is one', () => {
    const h = headline({ receivables: { total: 1500, overdue: 1000 } });
    const { unmount } = render(<OverviewKpiCards headline={h} overdueDisputed={250} />);
    expect(screen.getByText(`${exact(1000)} overdue`)).toBeTruthy();
    expect(screen.getByText(`of which ${exact(250)} disputed`)).toBeTruthy();
    unmount();
    render(<OverviewKpiCards headline={h} overdueDisputed={0} />);
    expect(screen.queryByText(/disputed/)).toBeNull();
  });

  it('attention list amounts', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ success: true, data: {
      asAt: '2026-11-12',
      items: [{ key: 'overdue-invoices', area: 'Sales', label: '3 overdue invoices', amount: 1234567.89, severity: 'overdue', href: '/x' }],
    } }), { status: 200 }));
    const { container } = render(<NeedsAttention />);
    expect(await screen.findByText(exact(1234567.89))).toBeTruthy();
    expect(container.textContent).not.toMatch(COMPACT);
  });
});
