/**
 * D2 (group 1c) SUCCESS paths: a 200 `{ success:true, data }` envelope is rendered / completes the action on the
 * journal-entry pages and the loan pages / tabs. The real apiJson / assertOk / apiErrorMessage run on the mocked apiFetch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

const routerState = vi.hoisted(() => ({ query: {} as Record<string, string>, push: vi.fn() }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: routerState.query, push: routerState.push }) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/gl/LinkTaxInvoiceButton', () => ({ LinkTaxInvoiceButton: () => null }));
vi.mock('@/components/accounting/DescriptionAutocomplete', () => ({
  DescriptionAutocomplete: ({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) =>
    <input value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />,
}));

import { apiFetch } from '@/lib/apiFetch';
import JournalEntryDetailPage from '../../../pages/accounting/journal-entries/[entryId]';
import NewJournalEntryPage from '../../../pages/accounting/journal-entries/new';
import LoanDetailPage from '../../../pages/accounting/loans/[id]';
import NewLoanPage from '../../../pages/accounting/loans/new';
import { LoanEventsTab } from '@/components/loans/LoanEventsTab';
import { LoanOverviewTab } from '@/components/loans/LoanOverviewTab';
import { LoanScheduleTab } from '@/components/loans/LoanScheduleTab';
import type { Loan } from '@/components/loans/types';

useApiJsonOverMock();
afterEach(() => { cleanup(); routerState.query = {}; routerState.push.mockReset(); });

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const sees = async (text: string) => { expect(await screen.findByText(text)).toBeTruthy(); };
const method = (init?: RequestInit) => (init?.method ?? 'GET').toUpperCase();

const LOAN: Loan = {
  id: 'loan-12345678', companyId: 'co-1', curveId: null, reference: 'L-1', product: 'bond', description: null,
  principal: 1000000, startDate: '2026-01-01', termMonths: 60, rateMode: 'FIXED', margin: 0, fixedRate: 10.5, residual: 0,
  dayCount: 'ACT/365', repriceMode: 'RESOLVE_ON_RATE_CHANGE', skipMode: 'MAINTAIN_TERM', lumpMode: 'REDUCE_INSTALLMENT',
  recurringSkipMonths: [], status: 'active', ncaCompliant: true, currency: 'ZAR', createdAt: '2026-01-01',
};

describe('D2 success envelope is honoured (group 1c)', () => {
  it('success: journal entry detail renders the data it received', async () => {
    routerState.query = { entryId: 'je-1' };
    vi.mocked(apiFetch).mockReset().mockImplementation(async () =>
      ok({ id: 'je-1', entryNumber: 'JE-90210', entryDate: '2026-01-15', status: 'draft', source: 'manual', createdBy: 'u1', description: 'Rent', lines: [] }));
    render(<JournalEntryDetailPage />);
    expect((await screen.findAllByText('JE-90210')).length).toBeGreaterThan(0);
  });

  it('success: new journal entry completes', async () => {
    vi.mocked(apiFetch).mockReset().mockImplementation(async (_u, init) =>
      method(init) === 'POST' ? ok({ id: 'je-new' }) : ok([
        { id: 'a1', accountCode: '1000', accountName: 'Bank', isActive: true },
        { id: 'a2', accountCode: '4000', accountName: 'Sales', isActive: true }]));
    render(<NewJournalEntryPage />);
    await screen.findAllByRole('option', { name: /1000 - Bank/ });
    const [s1, s2] = screen.getAllByRole('combobox');
    fireEvent.change(s1!, { target: { value: 'a1' } });
    fireEvent.change(s2!, { target: { value: 'a2' } });
    const amounts = screen.getAllByPlaceholderText('0.00'); // debit0, credit0, debit1, credit1
    fireEvent.change(amounts[0]!, { target: { value: '100' } });
    fireEvent.change(amounts[3]!, { target: { value: '100' } });
    fireEvent.submit(screen.getByRole('button', { name: /post journal entry/i }).closest('form')!);
    await sees('Journal entry created. Redirecting…');
  });

  it('success: loan detail renders the data it received', async () => {
    routerState.query = { id: 'loan-12345678' };
    vi.mocked(apiFetch).mockReset().mockImplementation(async (url) =>
      /\/(schedule|events)$/.test(String(url)) ? ok([]) : ok({ ...LOAN, reference: 'BOND-KIWI-77' }));
    render(<LoanDetailPage />);
    expect((await screen.findAllByText('BOND-KIWI-77')).length).toBeGreaterThan(0);
  });

  it('success: new loan completes', async () => {
    vi.mocked(apiFetch).mockReset().mockImplementation(async (_u, init) =>
      method(init) === 'POST' ? ok({ id: 'loan-created-9' }) : ok([]));
    const { container } = render(<NewLoanPage />);
    fireEvent.change(screen.getByPlaceholderText('1000000.00'), { target: { value: '5000000' } });
    fireEvent.change(container.querySelector('input[type="date"]')!, { target: { value: '2026-02-01' } });
    fireEvent.change(screen.getByPlaceholderText('60'), { target: { value: '60' } });
    fireEvent.change(screen.getByPlaceholderText('10.5'), { target: { value: '11' } });
    fireEvent.submit(screen.getByRole('button', { name: /create loan/i }).closest('form')!);
    await waitFor(() => expect(routerState.push).toHaveBeenCalledWith('/accounting/loans/loan-created-9'));
  });

  it('success: loan overview tab completes the status change', async () => {
    vi.mocked(apiFetch).mockReset().mockImplementation(async () => ok({}));
    const onRefresh = vi.fn();
    render(<LoanOverviewTab loan={LOAN} onRefresh={onRefresh} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'closed' } });
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
  });

  it('success: loan events tab completes the save', async () => {
    vi.mocked(apiFetch).mockReset().mockImplementation(async () => ok({}));
    const onRefresh = vi.fn();
    const { container } = render(<LoanEventsTab loanId="loan-1" events={[]} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole('button', { name: /add event/i }));
    fireEvent.change(container.querySelector('input[type="date"]')!, { target: { value: '2026-03-01' } });
    fireEvent.change(screen.getByPlaceholderText('Amount (ZAR)'), { target: { value: '5000' } });
    fireEvent.submit(screen.getByRole('button', { name: /save event/i }).closest('form')!);
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
  });

  it('success: loan schedule tab renders the data it received', async () => {
    const row = { period: 4242, date: '2031-07-15', opening: 1000, rate: 10, installment: 100, interest: 10, principal: 90, skip: false,
      payment: 100, lump: 0, closing: 910, stLiability: 0, extrapolated: false, nca_flagged: false };
    vi.mocked(apiFetch).mockReset().mockImplementation(async () => ok({ rows: [row] }));
    const { container } = render(<LoanScheduleTab loanId="loan-1" rows={[]} loading={false} />);
    fireEvent.click(screen.getByRole('button', { name: /preview what-if/i }));
    fireEvent.change(container.querySelector('input[type="date"]')!, { target: { value: '2031-07-15' } });
    fireEvent.click(screen.getByRole('button', { name: /run preview/i }));
    await sees('4242');
  });
});
