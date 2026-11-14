// M14: each host screen mounts the CommentsPanel on ITS record: the invoice drawer, the bill page and the bank line drawer.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner' }) }));
vi.mock('@/utils/toast', () => ({ notify: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { invoiceId: 'bill-9' } }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/ap/ThreeWayMatchPanel', () => ({ ThreeWayMatchPanel: () => null }));
vi.mock('@/modules/accounting/documents', () => ({ AccountingDocumentPanel: () => null }));
vi.mock('@/components/accounting/comments/CommentsPanel', () => ({
  CommentsPanel: (p: { recordType: string; recordId: string }) => <div data-testid="panel" data-type={p.recordType} data-id={p.recordId} />,
}));

import { apiFetch } from '@/lib/apiFetch';
import { InvoiceDrawerBody } from '@/components/accounting/customer-invoices/InvoiceDrawerBody';
import { BankLineDrawerBody } from '@/components/accounting/bank-transactions/BankLineDrawerBody';
import type { BankTx } from '@/components/accounting/BankTxTable';
import SupplierInvoiceDetailPage from '../../../pages/accounting/supplier-invoices/[invoiceId]';

useApiJsonOverMock();
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
afterEach(cleanup);

describe('the comments panel is mounted on its host', () => {
  it('invoice drawer: customer_invoice + the invoice id', async () => {
    vi.mocked(apiFetch).mockResolvedValue(ok({ id: 'inv-1', invoice_number: 'INV-1', client_name: 'A', status: 'draft', invoice_date: '2026-06-01',
      subtotal: '1', tax_amount: '0', total_amount: '1', amount_paid: '0', items: [] }));
    render(<InvoiceDrawerBody invoiceId="inv-1" />);
    const panel = await screen.findByTestId('panel');
    expect([panel.dataset.type, panel.dataset.id]).toEqual(['customer_invoice', 'inv-1']);
  });

  it('bill page: supplier_invoice + the bill id', async () => {
    vi.mocked(apiFetch).mockResolvedValue(ok({ id: 'bill-9', invoiceNumber: 'B-9', supplierName: 'S', status: 'draft', invoiceDate: '2026-06-12',
      dueDate: '2026-07-12', paymentTerms: '30 days', subtotal: 1, taxAmount: 0, taxRate: 15, totalAmount: 1, balance: 1, notes: '', items: [] }));
    render(<SupplierInvoiceDetailPage />);
    const panel = await screen.findByTestId('panel');
    expect([panel.dataset.type, panel.dataset.id]).toEqual(['supplier_invoice', 'bill-9']);
  });

  it('bank line drawer: bank_transaction + the line id', async () => {
    vi.mocked(apiFetch).mockResolvedValue(ok([]));
    const tx = { id: 'tx-7', transactionDate: '2026-06-01', description: 'X', amount: -1, status: 'imported' } as BankTx;
    render(<BankLineDrawerBody tx={tx} />);
    const panel = await screen.findByTestId('panel');
    expect([panel.dataset.type, panel.dataset.id]).toEqual(['bank_transaction', 'tx-7']);
  });
});
