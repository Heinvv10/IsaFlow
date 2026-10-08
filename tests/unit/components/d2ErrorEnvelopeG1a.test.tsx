/**
 * D2: the server's real error envelope `{ success:false, error:{ code, message } }` reaches the user.
 * These pages read `json.message` (always undefined) and so showed a generic fallback. Each test
 * answers the failing call with a distinctive envelope message and asserts it is painted.
 * The real apiJson / assertOk / apiErrorMessage run on top of the mocked apiFetch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/shared/ExportCSVButton', () => ({ ExportCSVButton: () => <button type="button">Export CSV</button> }));
vi.mock('@/hooks/useVatRegistration', () => ({ useVatRegistration: () => ({ isRegistered: true, known: true, setting: 'bi-monthly' }) }));

import { apiFetch } from '@/lib/apiFetch';
import AdjustmentsPage from '../../../pages/accounting/adjustments/index';
import BankTransfersPage from '../../../pages/accounting/bank-transfers/index';
import BudgetsPage from '../../../pages/accounting/budgets/index';
import BusinessUnitsPage from '../../../pages/accounting/business-units/index';
import DepreciationPage from '../../../pages/accounting/depreciation/index';
import DrcVatPage from '../../../pages/accounting/drc-vat/index';

useApiJsonOverMock();
afterEach(() => { cleanup(); });

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const refuse = (message: string, status = 400) =>
  new Response(JSON.stringify({ success: false, error: { code: 'BAD_REQUEST', message } }), { status });

type Route = (url: string, method: string) => Response | undefined;
function script(failing: Route, fallback: Record<string, unknown> = {}) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url, init) => {
    const u = String(url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const hit = failing(u, method);
    if (hit) return hit;
    const key = Object.keys(fallback).find((k) => u.includes(k));
    return ok(key ? fallback[key] : {});
  });
}
const sees = async (msg: string) => { expect(await screen.findByText(msg)).toBeTruthy(); };

describe('D2 envelope message reaches the user (group 1a)', () => {
  it('adjustments: create refusal is shown', async () => {
    const MSG = 'D2 server says no: adjustment period is locked';
    script((u, m) => (u.endsWith('/api/accounting/adjustments') && m === 'POST' ? refuse(MSG) : undefined), {
      '/customers': { items: [{ id: 'c1', company_name: 'Acme Ltd' }] }, '/adjustments': { items: [] },
    });
    const { container } = render(<AdjustmentsPage />);
    fireEvent.click(screen.getByRole('button', { name: /new adjustment/i }));
    await screen.findByRole('option', { name: 'Acme Ltd' });
    fireEvent.change(container.querySelector('select.ff-select')!, { target: { value: 'c1' } });
    fireEvent.change(screen.getByPlaceholderText('Amount *'), { target: { value: '10' } });
    fireEvent.change(screen.getByPlaceholderText('Reason *'), { target: { value: 'fix' } });
    fireEvent.submit(screen.getByRole('button', { name: /create adjustment/i }).closest('form')!);
    await sees(MSG);
  });

  it('bank transfers: refusal is shown', async () => {
    const MSG = 'D2 server says no: accounts are in a closed period';
    script((u, m) => (u.endsWith('/bank-transfers') && m === 'POST' ? refuse(MSG, 422) : undefined), {
      '/chart-of-accounts': [
        { id: 'a1', accountCode: '1000', accountName: 'Cheque', accountSubtype: 'bank' }, { id: 'a2', accountCode: '1100', accountName: 'Savings', accountSubtype: 'bank' }],
    });
    render(<BankTransfersPage />);
    await screen.findAllByRole('option', { name: /Cheque/ });
    const [from, to] = screen.getAllByRole('combobox');
    fireEvent.change(from!, { target: { value: 'a1' } });
    fireEvent.change(to!, { target: { value: 'a2' } });
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '50' } });
    fireEvent.click(screen.getByRole('button', { name: /process transfer/i }));
    await sees(MSG);
  });

  it('budgets: save refusal is shown', async () => {
    const MSG = 'D2 server says no: budget already exists for this account';
    script((u, m) => (u.endsWith('/api/accounting/budgets') && m === 'POST' ? refuse(MSG, 409) : undefined), {
      '/chart-of-accounts': { accounts: [{ id: 'g1', accountCode: '5000', accountName: 'Rent', accountType: 'expense' }] },
      '/budgets?': { items: [] },
    });
    render(<BudgetsPage />);
    fireEvent.click(screen.getByRole('button', { name: /add budget/i }));
    await screen.findByRole('option', { name: /Rent/ });
    fireEvent.change(screen.getByText('Select GL Account *').closest('select')!, { target: { value: 'g1' } });
    fireEvent.change(screen.getByPlaceholderText('Annual Amount *'), { target: { value: '1200' } });
    // Submit the form directly: a click is blocked here by jsdom's constraint validation on the numeric input.
    fireEvent.submit(screen.getByRole('button', { name: /save budget/i }).closest('form')!);
    await sees(MSG);
  });

  it('budgets: copy-to-next-year refusal is shown', async () => {
    const MSG = 'D2 server says no: next year already has budgets';
    script((u, m) => (u.includes('budgets-action') && m === 'POST' ? refuse(MSG, 409) : undefined), {
      '/budgets?': { items: [{ id: 'b1', glAccountId: 'g1', accountCode: '5000', accountName: 'Rent', accountType: 'expense',
        fiscalYear: 2026, annualAmount: 1200, months: [], notes: '' }] },
    });
    render(<BudgetsPage />);
    const copy = await screen.findByRole('button', { name: /copy to/i });
    await waitFor(() => expect((copy as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(copy);
    await sees(MSG);
  });

  it('business units: create refusal is shown', async () => {
    const MSG = 'D2 server says no: code FIN is already used';
    script((u, m) => (u.endsWith('/api/accounting/business-units') && m === 'POST' ? refuse(MSG, 409) : undefined), { '/business-units': [] });
    render(<BusinessUnitsPage />);
    fireEvent.click(screen.getByRole('button', { name: /new business unit/i }));
    fireEvent.change(screen.getByPlaceholderText('Name *'), { target: { value: 'Finance' } });
    fireEvent.change(screen.getByPlaceholderText('Code (e.g. FIN) *'), { target: { value: 'FIN' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await sees(MSG);
  });

  it('business units: edit refusal is shown', async () => {
    const MSG = 'D2 server says no: department is locked by payroll';
    script((u, m) => (u.endsWith('/api/accounting/business-units-action') && m === 'POST' ? refuse(MSG, 409) : undefined), {
      '/business-units': [{ id: 'd1', name: 'Ops', code: 'OPS', isActive: true }],
    });
    render(<BusinessUnitsPage />);
    fireEvent.click(await screen.findByTitle('Edit'));
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await sees(MSG);
  });

  it('depreciation: run refusal is shown', async () => {
    const MSG = 'D2 server says no: depreciation already run for this period';
    script((u, m) => (u.includes('run-depreciation') && m === 'POST' ? refuse(MSG, 409) : undefined), { '/assets': { items: [] } });
    render(<DepreciationPage />);
    fireEvent.click(screen.getByRole('button', { name: /run monthly depreciation/i }));
    await sees(MSG);
  });

  it('DRC VAT: apply refusal is shown', async () => {
    const MSG = 'D2 server says no: supplier invoice already carries VAT';
    script((u, m) => (u.endsWith('/api/accounting/drc-vat') && m === 'POST' ? refuse(MSG, 409) : undefined), {
      '/drc-vat': { items: [{ id: 'i1', invoiceNumber: 'INV-1', supplierName: 'Supplier', totalAmount: 100, vatAmount: 0, invoiceDate: '2026-01-01' }] },
    });
    render(<DrcVatPage />);
    fireEvent.click(await screen.findByRole('button', { name: /apply drc/i }));
    await sees(MSG);
  });
});
