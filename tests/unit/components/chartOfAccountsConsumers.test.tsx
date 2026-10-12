// GET /api/accounting/chart-of-accounts answers `data` as a plain array of GLAccount (camelCased accountCode /
// accountName). These pages read `data.accounts` / `.code` / `.name` / `.account_number` and so offered no accounts
// at all (found 2026-10-12 on the expense claim page, where it made posting a claim impossible). Fixtures are typed
// as the API's own GLAccount, so a change to the response type breaks compile here.
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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
type Page = () => JSX.Element | null;
type Modal = typeof import('@/components/accounting/AccountReportingGroupModal').AccountReportingGroupModal;
let ExpenseClaimDetail: Page; let PurchaseOrderDetailPage: Page; let NewItemPage: Page; let AccountReportingGroupModal: Modal;

// Each page pulls a large module graph; a cold first load under CI load outlasted the 1s-ish test budget.
// Load them here, under their own budget, so each test only pays for rendering.
beforeAll(async () => {
  const [e, p, n, m] = await Promise.all([
    import('../../../pages/accounting/expenses/[id]'),
    import('../../../pages/accounting/purchase-orders/[poId]'),
    import('../../../pages/accounting/items/new'),
    import('@/components/accounting/AccountReportingGroupModal'),
  ]);
  ExpenseClaimDetail = e.default as Page; PurchaseOrderDetailPage = p.default as Page;
  NewItemPage = n.default as Page; AccountReportingGroupModal = m.AccountReportingGroupModal;
}, 60_000);

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
  chartAccount('a-inactive-liab', '2190', 'Inactive Liability', { accountType: 'liability', isActive: false }),
  chartAccount('a-inactive-asset', '1190', 'Inactive Asset', { accountType: 'asset', isActive: false }),
  // A header that carries past postings: postableAccounts keeps it, a leaf rule does not.
  chartAccount('h-exp', '5100', 'Expense HEADER WITH POSTINGS', { level: 1, hasTransactions: true }),
  chartAccount('a-exp-child', '5110', 'Expense Child', { parentAccountId: 'h-exp' }),
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
    expect(screen.queryByRole('option', { name: /Inactive (Liability|Asset)/ })).toBeNull();
  });

  it('expense claim receipt line dropdown leaves out header and inactive accounts', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url: unknown) =>
      String(url).includes('chart-of-accounts') ? json(chart) : json({ claim: { ...claim, status: 'draft' } }));
    render(<ExpenseClaimDetail />);
    fireEvent.click(await screen.findByRole('button', { name: /add receipt/i }));
    await screen.findByRole('option', { name: '5000 — Purchases Expense' });
    expect(screen.queryByRole('option', { name: /HEADER/ })).toBeNull();
    expect(screen.queryByRole('option', { name: /Inactive Expense/ })).toBeNull();
    expect(screen.queryByRole('option', { name: /WITH POSTINGS/ })).toBeNull();
    expect(screen.getByRole('option', { name: '5110 — Expense Child' })).toBeTruthy();
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

  // A member deactivated since it was added: the default GET (active only) would hide it from the panel while it
  // stayed in the saved member list, invisible and unremovable. The modal asks for inactive rows too.
  describe('reporting group modal and a deactivated member', () => {
    const group = { id: 'g1', name: 'QAF1 group', report_type: 'both' as const, display_order: 0,
      members: [{ gl_account_id: 'a-inactive', account_code: '5900', account_name: 'Inactive Expense' }] };
    const serve = () => vi.mocked(apiFetch).mockImplementation(async (url: unknown) =>
      String(url).includes('chart-of-accounts')
        ? json(String(url).includes('includeInactive=true') ? chart : chart.filter(a => a.isActive))
        : json({}));

    it('shows the inactive member, marked inactive, and lets it be removed', async () => {
      serve();
      render(<AccountReportingGroupModal group={group} onClose={vi.fn()} onSaved={vi.fn()} />);
      const member = await screen.findByRole('button', { name: /5900.*Inactive Expense.*inactive/i });
      expect(screen.getByText('In Group (1)')).toBeTruthy();
      fireEvent.click(member);
      expect(screen.getByText('In Group (0)')).toBeTruthy();
    });

    it('does not offer inactive accounts as new members', async () => {
      serve();
      render(<AccountReportingGroupModal group={group} onClose={vi.fn()} onSaved={vi.fn()} />);
      await screen.findByRole('button', { name: /5900.*Inactive Expense/ });
      expect(screen.queryByRole('button', { name: /2190|1190/ })).toBeNull();
      expect(screen.getByRole('button', { name: /5000.*Purchases Expense/ })).toBeTruthy();
      // the member itself is not also listed as available
      expect(screen.getAllByRole('button', { name: /5900/ })).toHaveLength(1);
    });
  });
});
