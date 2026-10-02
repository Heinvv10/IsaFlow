/**
 * D2 (group 1b): the real error envelope `{ success:false, error:{ code, message } }` reaches the user
 * on the financial-years and group-eliminations pages. The real apiJson / assertOk / apiErrorMessage run
 * on top of the mocked apiFetch; only layout and the company context are faked.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ activeCompany: { id: 'co-1' } }) }));

import { apiFetch } from '@/lib/apiFetch';
import FinancialYearsPage from '../../../pages/accounting/financial-years/index';
import EliminationsPage from '../../../pages/accounting/group/eliminations';

useApiJsonOverMock();
afterEach(() => { cleanup(); });

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const refuse = (message: string, status = 409) =>
  new Response(JSON.stringify({ success: false, error: { code: 'CONFLICT', message } }), { status });
const sees = async (msg: string) => { expect(await screen.findByText(msg)).toBeTruthy(); };

const PERIOD = {
  id: 'p1', periodName: 'January 2026', periodNumber: 1, fiscalYear: 2026,
  startDate: '2026-01-01', endDate: '2026-01-31', status: 'open', createdAt: '2026-01-01', updatedAt: '2026-01-01',
};

/** POSTs whose JSON body has `action` equal to `failAction` are refused; everything else succeeds. */
function scriptYears(failAction: string | null, failCreate: boolean, message: string) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url, init) => {
    const u = String(url);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { action?: string; year?: number };
      if (u.includes('fiscal-periods-action') && body.action === failAction) return refuse(message);
      if (failCreate && u.endsWith('/fiscal-periods')) return refuse(message);
    }
    if (u.includes('jeCounts')) return ok({});
    return ok([PERIOD]);
  });
}

describe('financial years: refusal message reaches the user', () => {
  it('closing a period shows the server message', async () => {
    const MSG = 'D2 server says no: period has 3 unposted journals';
    scriptYears('close', false, MSG);
    render(<FinancialYearsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }));
    await sees(MSG);
  });

  it('closing the year shows the server message', async () => {
    const MSG = 'D2 server says no: year-end close needs retained earnings account';
    scriptYears('close_year', false, MSG);
    render(<FinancialYearsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /close year/i }));
    const confirm = (await screen.findAllByRole('button', { name: /close year/i })).at(-1)!;
    fireEvent.click(confirm);
    await sees(MSG);
  });

  it('adding a year shows the server message inside the modal', async () => {
    const MSG = 'D2 server says no: fiscal year 2027 overlaps an existing year';
    scriptYears(null, true, MSG);
    render(<FinancialYearsPage />);
    await screen.findByText('FY 2026');
    fireEvent.click(screen.getByRole('button', { name: /add new year/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Create Year' }));
    await sees(MSG);
  });
});

const ELIM = { id: 'e1', adjustmentNumber: 'ELM-1', adjustmentType: 'interco_revenue', description: 'Sales', periodStart: '2026-01-31', periodEnd: '2026-01-31', status: 'draft', lines: [{ debit: 100, credit: 0 }] };

/** Refuses a consolidated-reports POST whose `action` matches, with `message`. */
function scriptElim(failAction: string, message: string, item = ELIM) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url, init) => {
    const u = String(url);
    if (u.includes('action=accounts')) return ok({ items: [{ id: 'ga4', accountCode: '4000' }, { id: 'ga5', accountCode: '5000' }] });
    if (u.includes('company-groups')) return ok({ items: [{ id: 'g1', name: 'Group One' }] });
    if (u.includes('consolidated-reports') && (init?.method ?? 'GET').toUpperCase() === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { action?: string };
      if (body.action === failAction) return refuse(message, 422);
    }
    return ok({ items: [item] });
  });
}

describe('group eliminations: refusal message reaches the user', () => {
  it('auto-generate shows the server message', async () => {
    const MSG = 'D2 server says no: no intercompany transactions in range';
    scriptElim('auto-eliminate', MSG);
    render(<EliminationsPage />);
    const btn = await screen.findByRole('button', { name: /auto-generate/i });
    await vi.waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(btn);
    await sees(MSG);
  });

  it('posting an elimination shows the server message', async () => {
    const MSG = 'D2 server says no: elimination does not balance';
    scriptElim('post-elimination', MSG);
    render(<EliminationsPage />);
    fireEvent.click(await screen.findByTitle('Post elimination'));
    await sees(MSG);
  });

  it('reversing an elimination shows the server message', async () => {
    const MSG = 'D2 server says no: period is locked, cannot reverse';
    scriptElim('reverse-elimination', MSG, { ...ELIM, status: 'posted' });
    render(<EliminationsPage />);
    fireEvent.click(await screen.findByTitle('Reverse elimination'));
    await sees(MSG);
  });

  it('manual create shows the server message inside the modal', async () => {
    const MSG = 'D2 server says no: group account 4000 is not mapped';
    scriptElim('create-elimination', MSG);
    render(<EliminationsPage />);
    await screen.findByText('ELM-1');
    fireEvent.click(screen.getByRole('button', { name: /manual elimination/i }));
    fireEvent.change(screen.getByPlaceholderText('Describe the elimination adjustment...'), { target: { value: 'Sales' } });
    const codes = screen.getAllByPlaceholderText('e.g. 4000');
    fireEvent.change(codes[0]!, { target: { value: '4000' } });
    fireEvent.change(codes[1]!, { target: { value: '5000' } });
    const amounts = screen.getAllByPlaceholderText('0.00'); // debit0, credit0, debit1, credit1
    fireEvent.change(amounts[0]!, { target: { value: '100' } });
    fireEvent.change(amounts[3]!, { target: { value: '100' } });
    fireEvent.submit(screen.getByRole('button', { name: /create elimination/i }).closest('form')!);
    await sees(MSG);
  });
});
