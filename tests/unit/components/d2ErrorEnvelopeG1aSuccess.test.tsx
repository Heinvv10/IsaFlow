/**
 * D2 (group 1a) SUCCESS paths: a 200 `{ success:true, data }` envelope is rendered / completes the action.
 * The real apiJson / assertOk / apiErrorMessage run on top of the mocked apiFetch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
/** First matching URL fragment wins; anything else answers an empty success. */
function answer(map: Record<string, unknown>) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => {
    const u = String(url);
    const key = Object.keys(map).find((k) => u.includes(k));
    return ok(key ? map[key] : {});
  });
}
const sees = async (text: string) => { expect(await screen.findByText(text)).toBeTruthy(); };

describe('D2 success envelope is honoured (group 1a)', () => {
  it('success: adjustments renders the data it received', async () => {
    answer({ '/adjustments': { items: [{ id: 'j1', adjustmentNumber: 'ADJ-7731', entityName: 'Zulu Traders', adjustmentType: 'debit', amount: 10, reason: 'r', status: 'approved' }] } });
    render(<AdjustmentsPage />);
    await sees('ADJ-7731');
    await sees('Zulu Traders');
  });

  it('success: bank transfers completes', async () => {
    answer({ '/chart-of-accounts': [
      { id: 'a1', accountCode: '1000', accountName: 'Cheque', accountSubtype: 'bank' }, { id: 'a2', accountCode: '1100', accountName: 'Savings', accountSubtype: 'bank' }] });
    render(<BankTransfersPage />);
    await screen.findAllByRole('option', { name: /Cheque/ });
    const [from, to] = screen.getAllByRole('combobox');
    fireEvent.change(from!, { target: { value: 'a1' } });
    fireEvent.change(to!, { target: { value: 'a2' } });
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '50' } });
    fireEvent.click(screen.getByRole('button', { name: /process transfer/i }));
    await sees('Transfer completed — journal entry created');
  });

  it('success: budgets renders the data it received', async () => {
    answer({ '/budgets?': { items: [{ id: 'b1', glAccountId: 'g1', accountCode: '5000', accountName: 'Quokka Rentals', accountType: 'expense',
      fiscalYear: 2026, annualAmount: 1200, months: [], notes: '' }] } });
    render(<BudgetsPage />);
    await sees('Quokka Rentals');
  });

  it('success: business units renders the data it received', async () => {
    answer({ '/business-units': [{ id: 'd1', name: 'Wombat Operations', code: 'WOM', isActive: true }] });
    render(<BusinessUnitsPage />);
    await sees('Wombat Operations');
  });

  it('success: depreciation renders the data it received', async () => {
    answer({ '/assets': { items: [{ id: 's1', asset_number: 'FA-4417', name: 'Narwhal Press', purchase_price: 120000, useful_life_years: 5, current_book_value: 90000 }] } });
    render(<DepreciationPage />);
    await sees('Narwhal Press');
  });

  it('success: DRC VAT renders the data it received', async () => {
    answer({ '/drc-vat': { items: [{ id: 'i1', invoiceNumber: 'INV-5521', supplierName: 'Platypus Imports', totalAmount: 100, vatAmount: 0, invoiceDate: '2026-01-01' }] } });
    render(<DrcVatPage />);
    await sees('Platypus Imports');
  });
});
