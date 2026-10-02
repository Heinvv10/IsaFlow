/**
 * D2 (group 1c): the real error envelope `{ success:false, error:{ code, message } }` reaches the user on the
 * journal-entry pages and the loan pages / tabs. The real apiJson / assertOk / apiErrorMessage run on top of
 * the mocked apiFetch; only layout, router, links and heavy children are faked.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

const routerState = vi.hoisted(() => ({ query: {} as Record<string, string> }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: routerState.query, push: vi.fn() }) }));
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
afterEach(() => { cleanup(); routerState.query = {}; });

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const refuse = (message: string, status = 409) =>
  new Response(JSON.stringify({ success: false, error: { code: 'CONFLICT', message } }), { status });
const sees = async (msg: string) => { expect(await screen.findByText(msg)).toBeTruthy(); };
const method = (init?: RequestInit) => (init?.method ?? 'GET').toUpperCase();

const ENTRY = { id: 'je-1', entryNumber: 'JE-0001', entryDate: '2026-01-15', status: 'draft', source: 'manual', createdBy: 'u1', description: 'Rent', lines: [] };

describe('journal entry detail: refusal message reaches the user', () => {
  it('loading the entry shows the server message', async () => {
    const MSG = 'D2 server says no: journal entry belongs to another company';
    routerState.query = { entryId: 'je-1' };
    vi.mocked(apiFetch).mockReset().mockImplementation(async () => refuse(MSG, 404));
    render(<JournalEntryDetailPage />);
    await sees(MSG);
  });

  it('posting the entry shows the server message', async () => {
    const MSG = 'D2 server says no: period 2026-01 is locked';
    routerState.query = { entryId: 'je-1' };
    vi.mocked(apiFetch).mockReset().mockImplementation(async (_u, init) =>
      method(init) === 'POST' ? refuse(MSG, 422) : ok(ENTRY));
    render(<JournalEntryDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /post entry/i }));
    await sees(MSG);
  });

  it('reversing the entry shows the server message', async () => {
    const MSG = 'D2 server says no: reversal date falls in a closed period';
    routerState.query = { entryId: 'je-1' };
    vi.mocked(apiFetch).mockReset().mockImplementation(async (_u, init) =>
      method(init) === 'POST' ? refuse(MSG, 422) : ok({ ...ENTRY, status: 'posted' }));
    render(<JournalEntryDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^reverse$/i }));
    await sees(MSG);
  });
});

describe('new journal entry: refusal message reaches the user', () => {
  it('creating the entry shows the server message', async () => {
    const MSG = 'D2 server says no: account 1000 does not accept manual journals';
    vi.mocked(apiFetch).mockReset().mockImplementation(async (_u, init) =>
      method(init) === 'POST' ? refuse(MSG, 422) : ok([
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
    await sees(MSG);
  });
});

const LOAN: Loan = {
  id: 'loan-12345678', companyId: 'co-1', curveId: null, reference: 'L-1', product: 'bond', description: null,
  principal: 1000000, startDate: '2026-01-01', termMonths: 60, rateMode: 'FIXED', margin: 0, fixedRate: 10.5, residual: 0,
  dayCount: 'ACT/365', repriceMode: 'RESOLVE_ON_RATE_CHANGE', skipMode: 'MAINTAIN_TERM', lumpMode: 'REDUCE_INSTALLMENT',
  recurringSkipMonths: [], status: 'active', ncaCompliant: true, currency: 'ZAR', createdAt: '2026-01-01',
};

describe('loans: refusal message reaches the user', () => {
  it('loan detail page shows why the loan could not be loaded', async () => {
    const MSG = 'D2 server says no: loan belongs to a deleted portfolio';
    routerState.query = { id: 'loan-12345678' };
    vi.mocked(apiFetch).mockReset().mockImplementation(async () => refuse(MSG, 404));
    render(<LoanDetailPage />);
    await sees(MSG);
  });

  it('new loan page shows why the loan was refused', async () => {
    const MSG = 'D2 server says no: principal exceeds the facility limit';
    vi.mocked(apiFetch).mockReset().mockImplementation(async (_u, init) =>
      method(init) === 'POST' ? refuse(MSG, 422) : ok([]));
    const { container } = render(<NewLoanPage />);
    fireEvent.change(screen.getByPlaceholderText('1000000.00'), { target: { value: '5000000' } });
    fireEvent.change(container.querySelector('input[type="date"]')!, { target: { value: '2026-02-01' } });
    fireEvent.change(screen.getByPlaceholderText('60'), { target: { value: '60' } });
    fireEvent.change(screen.getByPlaceholderText('10.5'), { target: { value: '11' } });
    fireEvent.submit(screen.getByRole('button', { name: /create loan/i }).closest('form')!);
    await sees(MSG);
  });

  it('overview tab shows why the status change was refused', async () => {
    const MSG = 'D2 server says no: loan still has an outstanding balance';
    vi.mocked(apiFetch).mockReset().mockImplementation(async () => refuse(MSG, 422));
    render(<LoanOverviewTab loan={LOAN} onRefresh={vi.fn()} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'closed' } });
    await sees(MSG);
  });

  it('events tab shows why the event was refused', async () => {
    const MSG = 'D2 server says no: lump sum exceeds the outstanding balance';
    vi.mocked(apiFetch).mockReset().mockImplementation(async () => refuse(MSG, 422));
    const { container } = render(<LoanEventsTab loanId="loan-1" events={[]} onRefresh={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /add event/i }));
    fireEvent.change(container.querySelector('input[type="date"]')!, { target: { value: '2026-03-01' } });
    fireEvent.change(screen.getByPlaceholderText('Amount (ZAR)'), { target: { value: '5000' } });
    fireEvent.submit(screen.getByRole('button', { name: /save event/i }).closest('form')!);
    await sees(MSG);
  });

  it('schedule tab shows why the what-if preview was refused', async () => {
    const MSG = 'D2 server says no: what-if event date is before the loan start';
    vi.mocked(apiFetch).mockReset().mockImplementation(async () => refuse(MSG, 422));
    const { container } = render(<LoanScheduleTab loanId="loan-1" rows={[]} loading={false} />);
    fireEvent.click(screen.getByRole('button', { name: /preview what-if/i }));
    fireEvent.change(container.querySelector('input[type="date"]')!, { target: { value: '2025-01-01' } });
    fireEvent.click(screen.getByRole('button', { name: /run preview/i }));
    await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalled());
    await sees(MSG);
  });
});
