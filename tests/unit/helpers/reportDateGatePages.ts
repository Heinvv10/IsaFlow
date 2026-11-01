// Every report page with filter dates: its date labels, the actions a refused date must stop, and just enough
// data for those actions to be enabled first (a test that starts from a disabled button proves nothing).
import type { ComponentType } from 'react';
import { act, fireEvent, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';

export interface GatePage {
  file: string;
  load: () => Promise<{ default: ComponentType }>;
  dates: string[];
  /** Empty for a page with no run or export action: the refusal is then only reported, not gated. */
  actions: RegExp[];
  data?: unknown;
  /** Steps the page needs before its actions are enabled. */
  prepare?: () => Promise<void>;
}

const FROM_TO = ['From', 'To'];
const CSV = [/Export CSV/];
const SHORT_CSV = [/CSV/];
const agingRow = { id: 'r1', invoice_number: 'INV-1', invoice_date: '2026-04-01', due_date: '2026-04-30',
  total_amount: 10, amount_paid: 0, balance_due: 10, days_overdue: 0, bucket: 'current' };
const aging = { rows: [{ ...agingRow, customer_name: 'A', supplier_name: 'A' }], summary: [], as_at_date: '2026-04-30' };
const ledger = { customer_name: 'A', opening_balance: 0, closing_balance: 10, transactions: [
  { type: 'invoice', transaction_id: 't1', reference: 'INV-1', transaction_date: '2026-04-01', debit: 10, credit: 0, status: 'open', running_balance: 10 },
] };
const statementLine = { accountId: 'a', accountCode: '1', accountName: 'A', amount: 0 };
const pack = { type: 'board', companyName: 'Co', period: 'p', sections: [] };

async function runCustomerLedger(): Promise<void> {
  const select = screen.getByRole('combobox');
  fireEvent.focus(select);
  await screen.findByRole('option', { name: 'A' });
  fireEvent.change(select, { target: { value: 'c1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Run Report' }));
  await screen.findByText(/Opening Balance/i);
}

export const GATE_PAGES: GatePage[] = [
  { file: 'account-transactions', load: () => import('@/../pages/accounting/reports/account-transactions'), dates: FROM_TO, actions: CSV,
    data: { accountCode: '1110', accountName: 'Bank', accountType: 'asset', openingBalance: 0, closingBalance: 0, transactions: [] } },
  { file: 'ap-aging', load: () => import('@/../pages/accounting/reports/ap-aging'), dates: ['As at date'], actions: CSV, data: aging },
  { file: 'ar-aging', load: () => import('@/../pages/accounting/reports/ar-aging'), dates: ['As at date'], actions: CSV, data: aging },
  { file: 'audit-trail', load: () => import('@/../pages/accounting/reports/audit-trail'), dates: FROM_TO, actions: CSV,
    data: [{ entryDate: '2026-04-01', entryNumber: 'J1', description: 'd', source: 'manual', status: 'posted', totalDebit: 1, totalCredit: 1, createdBy: 'x', createdAt: '2026-04-01', postedAt: null }] },
  { file: 'balance-sheet', load: () => import('@/../pages/accounting/reports/balance-sheet'), dates: ['As at'], actions: [/Export CSV/, /Export Excel/],
    data: { assets: [statementLine], liabilities: [], equity: [], totalAssets: 0, totalLiabilities: 0, totalEquity: 0 } },
  { file: 'bank-transactions', load: () => import('@/../pages/accounting/reports/bank-transactions'), dates: FROM_TO, actions: CSV,
    data: { accountCode: '1110', accountName: 'Bank', openingBalance: 0, closingBalance: 0, transactions: [{ date: '2026-04-01', entryNumber: 'J1', description: 'd', deposit: 1, withdrawal: 0, runningBalance: 1 }] } },
  { file: 'caseware-export', load: () => import('@/../pages/accounting/reports/caseware-export'), dates: ['Period From', 'Period To'], actions: CSV },
  { file: 'cash-flow', load: () => import('@/../pages/accounting/reports/cash-flow'), dates: FROM_TO, actions: CSV,
    data: { period_start: '2026-04-01', period_end: '2026-04-30', sections: [], net_change: 0, opening_cash: 0, closing_cash: 0 } },
  { file: 'cash-movement', load: () => import('@/../pages/accounting/reports/cash-movement'), dates: FROM_TO, actions: [], data: { accounts: [] } },
  { file: 'customer-communication', load: () => import('@/../pages/accounting/reports/customer-communication'), dates: FROM_TO, actions: SHORT_CSV,
    data: { records: [{ id: 'r1', customerName: 'A', email: 'a@example.com', documentType: 'invoice', documentNumber: 'INV-1', subject: 's', status: 'sent', sentAt: '2026-04-01' }], total: 120, page: 1, limit: 50 } },
  { file: 'customer-ledger', load: () => import('@/../pages/accounting/reports/customer-ledger'), dates: FROM_TO, actions: [/Run Report/, /Export CSV/],
    data: ledger, prepare: runCustomerLedger },
  { file: 'customer-reports', load: () => import('@/../pages/accounting/reports/customer-reports'), dates: FROM_TO, actions: CSV,
    data: [{ clientId: 'c', clientName: 'A', invoiceCount: 1, totalInvoiced: 1, totalPaid: 0, balance: 1 }] },
  { file: 'executive-dashboard', load: () => import('@/../pages/accounting/reports/executive-dashboard'), dates: FROM_TO, actions: [], data: {} },
  { file: 'general-ledger', load: () => import('@/../pages/accounting/reports/general-ledger'), dates: FROM_TO, actions: CSV, data: { accounts: [] } },
  { file: 'item-movement', load: () => import('@/../pages/accounting/reports/item-movement'), dates: FROM_TO, actions: SHORT_CSV },
  { file: 'journal-entries', load: () => import('@/../pages/accounting/reports/journal-entries'), dates: FROM_TO, actions: SHORT_CSV,
    data: { entries: [{ id: 'j', entryNumber: 'J1', entryDate: '2026-04-01', description: 'd', source: 'manual', status: 'posted', totalDebits: 1, totalCredits: 1 }], total: 1 } },
  { file: 'management-accounts', load: () => import('@/../pages/accounting/reports/management-accounts'), dates: FROM_TO, actions: [/^Run$/, /Download PDF/, /Email to Director/] },
  { file: 'project-profitability', load: () => import('@/../pages/accounting/reports/project-profitability'), dates: FROM_TO, actions: [] },
  { file: 'purchases-by-item', load: () => import('@/../pages/accounting/reports/purchases-by-item'), dates: FROM_TO, actions: SHORT_CSV },
  { file: 'purchases-by-supplier', load: () => import('@/../pages/accounting/reports/purchases-by-supplier'), dates: FROM_TO, actions: SHORT_CSV },
  { file: 'report-packs', load: () => import('@/../pages/accounting/reports/report-packs'), dates: FROM_TO, actions: [/^PDF$/, /^PowerPoint$/],
    data: { pack, unclassifiedAccounts: null } },
  { file: 'sales-by-customer', load: () => import('@/../pages/accounting/reports/sales-by-customer'), dates: FROM_TO, actions: SHORT_CSV },
  { file: 'sales-by-item', load: () => import('@/../pages/accounting/reports/sales-by-item'), dates: FROM_TO, actions: SHORT_CSV },
  { file: 'supplier-pos', load: () => import('@/../pages/accounting/reports/supplier-pos'), dates: FROM_TO, actions: SHORT_CSV,
    data: { suppliers: [{ supplierId: 's', supplierName: 'S', poCount: 0, totalValue: 0, pos: [] }], grandTotal: 0, grandPoCount: 0 } },
  { file: 'supplier-reports', load: () => import('@/../pages/accounting/reports/supplier-reports'), dates: FROM_TO, actions: CSV,
    data: [{ clientId: 'c', supplierId: 'c', clientName: 'A', supplierName: 'A', invoiceCount: 1, totalInvoiced: 1, totalPaid: 0, balance: 1 }] },
  { file: 'vat-reconciliation', load: () => import('@/../pages/accounting/reports/vat-reconciliation'), dates: FROM_TO, actions: [],
    data: { issues: [], months: [], totals: {}, summary: [] } },
];

const response = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });

/** Answer the page's reference lookups, and everything else with its report data. */
export function serve(page: GatePage): void {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => {
    const path = String(url);
    if (path.includes('cost-centres')) return response({ items: [{ id: 'cc1', code: 'C1', name: 'One' }] });
    if (path.includes('business-units')) return response([]);
    if (path.includes('fiscal-periods')) return response({ startDate: '2026-04-01', endDate: '2026-04-30' });
    if (path.includes('chart-of-accounts')) return response([
      { id: 'b1', accountCode: '1110', accountName: 'Bank' }, { id: 'b2', accountCode: '1120', accountName: 'Savings' },
    ]);
    if (path.includes('/api/accounting/customers')) return response([{ id: 'c1', name: 'A' }]);
    return response(page.data ?? []);
  });
}

/** Let every queued microtask, effect and 0 ms timer run, inside act. */
export async function settle(): Promise<void> {
  await act(async () => { for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
}

export const gatePage = (file: string): GatePage => {
  const page = GATE_PAGES.find((p) => p.file === file);
  if (!page) throw new Error(`No gate page ${file}`);
  return page;
};
