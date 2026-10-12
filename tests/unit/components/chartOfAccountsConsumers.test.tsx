// GET /api/accounting/chart-of-accounts answers `data` as a plain array of GLAccount (camelCased accountCode /
// accountName). These pages read `data.accounts` / `.code` / `.name` / `.account_number` and so offered no accounts
// at all (found 2026-10-12 on the expense claim page, where it made posting a claim impossible). Fixtures are typed
// as the API's own GLAccount, so a change to the response type breaks compile here.
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { GLAccount } from '@/modules/accounting/types/gl.types';
import { chartAccount } from '../helpers/chartAccount';

vi.mock('next/link', () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/supplier-invoices/SupplierSelect', () => ({ SupplierSelect: () => <div /> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ activeCompany: null, companyRole: 'owner' }) }));
const router = { query: { id: 'claim-1', poId: 'po-1' } as Record<string, string>, push: vi.fn(), replace: vi.fn(), pathname: '/', isReady: true };
vi.mock('next/router', () => ({ useRouter: () => router }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import ExpenseClaimDetail from '../../../pages/accounting/expenses/[id]';
import PurchaseOrderDetailPage from '../../../pages/accounting/purchase-orders/[poId]';
import NewItemPage from '../../../pages/accounting/items/new';
import { AccountReportingGroupModal } from '@/components/accounting/AccountReportingGroupModal';

const json = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
afterEach(() => { vi.mocked(apiFetch).mockReset(); });

const chart: GLAccount[] = [
  // Headers (they have children): the post route refuses them, so the page must not offer them.
  chartAccount('h-liab', '2000', 'Liabilities HEADER', { accountType: 'liability', level: 1 }),
  chartAccount('h-asset', '1000', 'Assets HEADER', { accountType: 'asset', level: 1 }),
  chartAccount('a-liab', '2100', 'Employee Reimbursements', { accountType: 'liability', parentAccountId: 'h-liab' }),
  chartAccount('a-vat', '1140', 'VAT Input', { accountType: 'asset', parentAccountId: 'h-asset' }),
  chartAccount('a-sales', '4000', 'Sales Revenue', { accountType: 'revenue' }),
  chartAccount('a-cost', '5000', 'Purchases Expense'),
  chartAccount('a-inactive', '5900', 'Inactive Expense', { isActive: false }),
];

const claim = {
  id: 'claim-1', claimNumber: 'EC-1', claimDate: '2026-10-01', employeeId: 'e1', title: 'QAF1', description: null,
  status: 'approved', totalAmount: 115, totalVat: 15, approvedBy: null, approvedAt: null, rejectionReason: null,
  postedJeId: null, postedAt: null, submittedAt: null, lines: [],
};

describe('chart-of-accounts consumers read the real response shape', () => {
  it('expense claim page fills the Post to GL dropdowns', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url: unknown) =>
      String(url).includes('chart-of-accounts') ? json(chart) : json({ claim }));
    render(<ExpenseClaimDetail />);
    fireEvent.click(await screen.findByRole('button', { name: /post to gl/i }));
    await waitFor(() => expect(screen.getAllByRole('option', { name: '2100 — Employee Reimbursements' })).toHaveLength(1));
    expect(screen.getAllByRole('option', { name: '1140 — VAT Input' })).toHaveLength(1);
  });

  it('expense claim post dropdowns offer only the leaf accounts of the type the route accepts', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url: unknown) =>
      String(url).includes('chart-of-accounts') ? json(chart) : json({ claim }));
    render(<ExpenseClaimDetail />);
    fireEvent.click(await screen.findByRole('button', { name: /post to gl/i }));
    await screen.findByRole('option', { name: '2100 — Employee Reimbursements' });
    const [reimb, vat] = screen.getAllByRole('combobox').slice(-2) as HTMLSelectElement[];
    const names = (s: HTMLSelectElement) => Array.from(s.options).map(o => o.textContent);
    expect(names(reimb!)).toEqual(['Select account…', '2100 — Employee Reimbursements']);
    expect(names(vat!)).toEqual(['None — skip VAT leg', '1140 — VAT Input']);
  });

  it('expense claim receipt line dropdown leaves out header and inactive accounts', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url: unknown) =>
      String(url).includes('chart-of-accounts') ? json(chart) : json({ claim: { ...claim, status: 'draft' } }));
    render(<ExpenseClaimDetail />);
    fireEvent.click(await screen.findByRole('button', { name: /add receipt/i }));
    await screen.findByRole('option', { name: '5000 — Purchases Expense' });
    expect(screen.queryByRole('option', { name: /HEADER/ })).toBeNull();
    expect(screen.queryByRole('option', { name: /Inactive Expense/ })).toBeNull();
  });

  it('purchase order edit offers the accounts on each line', async () => {
    const po = { id: 'po-1', po_number: 'PO-1', supplier_id: null, supplier_name: null, supplier_email: null, supplier_phone: null,
      order_date: '2026-10-01', expected_delivery_date: null, status: 'draft', subtotal: 100, tax_amount: 15, total: 115,
      notes: null, reference: null, created_at: '2026-10-01', items: [{ description: 'x', quantity: 1, unit_price: 100, tax_rate: 15 }] };
    vi.mocked(apiFetch).mockImplementation(async (url: unknown) =>
      String(url).includes('chart-of-accounts') ? json(chart) : json(po));
    render(<PurchaseOrderDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /edit/i }));
    expect(await screen.findByRole('option', { name: '5000 – Purchases Expense' })).toBeTruthy();
  });

  it('new item page offers sales and purchase accounts', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url: unknown) =>
      String(url).includes('chart-of-accounts') ? json(chart) : json([]));
    render(<NewItemPage />);
    expect(await screen.findByRole('option', { name: '4000 - Sales Revenue' })).toBeTruthy();
    expect(screen.getByRole('option', { name: '5000 - Purchases Expense' })).toBeTruthy();
  });

  it('reporting group modal lists the accounts to assign', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url: unknown) =>
      String(url).includes('chart-of-accounts') ? json(chart) : json({ accounts: [] }));
    render(<AccountReportingGroupModal group={null} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(await screen.findByText('Employee Reimbursements')).toBeTruthy();
    expect(screen.getByText('2100')).toBeTruthy();
  });
});
