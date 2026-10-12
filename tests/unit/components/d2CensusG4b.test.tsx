/**
 * D2 census group 4 (b): customer invoice detail, customer statements, new expense claim, new item, AR invoice
 * migration. A 400 shows the server's message, an empty 500 a plain sentence (never "Unexpected end of JSON
 * input"), a 200 renders the data.
 * LEFT: customer-invoices adjacent lookup (prev/next arrows stay disabled by design).
 */
import { chartAccount } from '../helpers/chartAccount';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, vi } from 'vitest';
import { mockedApiFetchModule, useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { invoiceId: 'inv-1' }, push: vi.fn(), replace: vi.fn(), pathname: '/' }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/modules/accounting/documents', () => ({ AccountingDocumentPanel: () => null }));
vi.mock('@/contexts/CompanyContext', () => {
  const value = { company: { id: 'co-1', name: 'Acme' } };
  return { useCompany: () => value };
});
vi.mock('@/components/accounting/migration/InvoiceImportResult', () => ({ default: () => null }));
vi.mock('@/components/accounting/sars/MarkVatDeclaredElsewhereButton', () => ({ MarkVatDeclaredElsewhereButton: () => null }));
vi.mock('@/components/invoices/CustomerInvoiceSummary', () => ({ CustomerInvoiceSummary: () => null }));
vi.mock('@/components/invoices/InvoiceActionBar', () => ({ InvoiceActionBar: () => null }));
vi.mock('@/components/invoices/InvoiceEmailModal', () => ({ InvoiceEmailModal: () => null }));
vi.mock('@/modules/accounting/hooks/useCustomerInvoiceActions', () => ({ useCustomerInvoiceActions: () => ({ groups: [], overflowActions: [] }) }));
vi.mock('papaparse', () => ({
  default: { parse: (_file: unknown, opts: { complete: (r: unknown) => void }) => opts.complete({
    data: [{ invoice_number: 'INV-D2-1', customer_name: 'Nobody Known', total_amount: '10' }],
    meta: { fields: ['invoice_number', 'customer_name', 'total_amount'] } }) },
}));

import InvoiceDetailPage from '../../../pages/accounting/customer-invoices/[invoiceId]';
import StatementsPage from '../../../pages/accounting/customer-statements/index';
import NewExpensePage from '../../../pages/accounting/expenses/new';
import NewItemPage from '../../../pages/accounting/items/new';
import ArInvoicesMigrationPage from '../../../pages/accounting/migration/ar-invoices';
import { ok, trio } from '../helpers/d2CensusG4';

void mockedApiFetchModule;
useApiJsonOverMock();
afterEach(() => { cleanup(); });

describe('customer-invoices detail load', () => {
  trio({ name: 'invoice detail', render: () => render(<InvoiceDetailPage />), match: u => u.includes('customer-invoices-detail'),
    data: { id: 'inv-1', invoice_number: 'INV-D2-777', client_name: 'Acme', project_name: 'P', status: 'approved', total_amount: 100, amount_paid: 0, lines: [] },
    others: u => (u.includes('adjacent') ? ok({ prevId: null, nextId: null }) : undefined),
    plain: 'Could not load the invoice - try again', success: /INV-D2-777/ });
});

describe('customer-statements load', () => {
  trio({ name: 'statements', render: () => render(<StatementsPage />), match: u => u.includes('customer-statements'),
    data: { customers: [{ client_id: 'c1', client_name: 'D2 Statement Customer', total_invoiced: 10, total_paid: 0, total_credits: 0, balance: 10, invoice_count: 1 }] },
    plain: 'Could not load the customer statements - try again', success: /D2 Statement Customer/ });
});

describe('expenses/new employee list', () => {
  trio({ name: 'employee list', render: () => render(<NewExpensePage />), match: u => u.includes('payroll/employees'),
    data: [{ id: 'e1', first_name: 'Dee', last_name: 'Employee777', email: 'd@x.co' }],
    plain: 'Could not load the employees - try again', success: /Dee Employee777/ });
});

describe('items/new lookups', () => {
  const lists = (u: string) => (u.includes('item-categories') || u.includes('chart-of-accounts') ? ok([]) : undefined);
  trio({ name: 'item categories', render: () => render(<NewItemPage />), match: u => u.includes('item-categories'),
    data: [{ id: 'k1', name: 'D2 Category 777' }], others: lists,
    plain: 'Could not load the item categories - try again', success: /D2 Category 777/ });
  trio({ name: 'item accounts', render: () => render(<NewItemPage />), match: u => u.includes('chart-of-accounts'),
    data: [chartAccount('a1', '4000', 'D2 Sales 777')], others: lists,
    plain: 'Could not load the accounts - try again', success: /D2 Sales 777/ });
});

describe('migration/ar-invoices customer list', () => {
  trio({ name: 'customer list', render: () => render(<ArInvoicesMigrationPage />), match: u => u.includes('/customers?'),
    data: [{ id: 'c1', name: 'D2 Customer 777' }],
    drive: async () => {
      fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [new File(['a'], 'x.csv', { type: 'text/csv' })] } });
    },
    plain: 'Could not load the customer list - try again', success: /D2 Customer 777/ });
});
