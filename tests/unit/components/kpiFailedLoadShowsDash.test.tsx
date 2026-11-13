/**
 * A headline figure that did not load is a dash with a Retry, never R 0.00 or 0
 * (audit b.1): a zero reads as "nothing owed / nothing to do", which a failed
 * load cannot know. Covers the KPI row and the "Needs attention" list.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('next/router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/contexts/CompanyContext', () => ({
  useCompany: () => ({ activeCompany: { id: 'co-1', name: 'Demo' }, companies: [], loading: false, companyRole: 'owner', switchCompany: vi.fn() }),
}));
const apiFetch = vi.fn();
vi.mock('@/lib/apiFetch', () => ({
  apiFetch: (...a: unknown[]) => apiFetch(...a),
  assertOk: async (res: Response, fallback: string) => { if (!res.ok) throw new Error(fallback); },
  apiErrorMessage: (_e: unknown, fallback: string) => fallback,
}));

import { OverviewKpiCards } from '@/components/accounting/dashboard/OverviewKpiCards';
import { NeedsAttention } from '@/components/accounting/dashboard/NeedsAttention';

const fail500 = () => new Response('', { status: 500 });
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const ZERO_RAND = /R\s?0[.,]00/;
const calls = (needle: string) => apiFetch.mock.calls.filter(([u]) => String(u).includes(needle)).length;

beforeEach(() => { apiFetch.mockReset(); });
afterEach(cleanup);

describe('KPI cards with no figures', () => {
  it('show the placeholder, no R 0.00, no "No overdue", and a Retry that calls back', () => {
    const onRetry = vi.fn();
    const { container } = render(<OverviewKpiCards headline={undefined} onRetry={onRetry} />);
    expect(container.textContent).not.toMatch(ZERO_RAND);
    expect(screen.queryByText(/No overdue/)).toBeNull();
    expect(screen.queryByText(/vs prior period/)).toBeNull();
    expect(screen.queryByText(/change/)).toBeNull();
    for (const title of ['Cash', 'Receivables', 'Payables', 'Profit this month']) expect(screen.getByText(title)).toBeTruthy();
    expect(container.querySelectorAll('span.tabular-nums').length).toBe(4);
    // A screen reader hears why each card has no figure.
    expect(screen.getAllByText('not loaded')).toHaveLength(4);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('with only the disputed figure known (no headline) still show no figure', () => {
    const { container } = render(<OverviewKpiCards headline={undefined} overdueDisputed={0} />);
    expect(container.textContent).not.toMatch(ZERO_RAND);
    expect(screen.queryByText(/disputed/)).toBeNull();
  });
});

describe('Needs attention on a 500', () => {
  it('shows the failure and Retry, no all-clear and no rows; Retry fetches again and then shows the rows', async () => {
    apiFetch.mockResolvedValueOnce(fail500());
    const { container } = render(<NeedsAttention />);
    expect(await screen.findByText('Could not load the attention list - try again')).toBeTruthy();
    expect(screen.queryByText('All caught up!')).toBeNull();
    expect(container.querySelectorAll('li').length).toBe(0);
    expect(container.textContent).not.toMatch(/\b0\b/);
    apiFetch.mockResolvedValueOnce(ok({
      asAt: '2026-11-12',
      items: [{ key: 'draft-invoices', area: 'Sales', label: '7 draft invoices', severity: 'info', href: '/accounting/customer-invoices?filter=draft' }],
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('7 draft invoices')).toBeTruthy();
    expect(calls('dashboard/attention')).toBe(2);
    expect(screen.queryByText('Could not load the attention list - try again')).toBeNull();
  });
});
