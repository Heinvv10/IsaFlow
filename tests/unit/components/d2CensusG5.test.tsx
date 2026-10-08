// Census group 5 (list pages): a 4xx shows the server's message, an empty 5xx body shows a plain
// sentence (never "Unexpected end of JSON input"), and a 200 envelope still renders its data.
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComponentType, ReactNode } from 'react';

vi.mock('next/link', () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ push: vi.fn(), query: {}, pathname: '/' }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/logger', () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import DunningRunsPage from '../../../pages/accounting/ar/dunning/runs';
import BankTransfersPage from '../../../pages/accounting/bank-transfers/index';
import CreditNotesPage from '../../../pages/accounting/credit-notes/index';
import GoodsReceivedPage from '../../../pages/accounting/goods-received/index';
import CustomerCommunicationReport from '../../../pages/accounting/reports/customer-communication';
import SalesByCustomerReport from '../../../pages/accounting/reports/sales-by-customer';
import SupplierPaymentsPage from '../../../pages/accounting/supplier-payments/index';
import { ContactsTab } from '../../../src/components/accounting/suppliers/ContactsTab';

const MSG = 'D2 server says no: not allowed here';
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const refused = () => new Response(JSON.stringify({ success: false, error: { code: 'BAD_REQUEST', message: MSG } }), { status: 400 });
afterEach(() => { vi.mocked(apiFetch).mockReset(); });

interface Case { name: string; Page: ComponentType; url: string; data: unknown; shows: string; plain: RegExp }
const cases: Case[] = [
  { name: 'dunning runs', Page: DunningRunsPage, url: 'dunning/sends', plain: /Could not load send history/,
    data: { sends: [{ id: 's1', invoice_number: 'INV-D2-777', customer_name: 'D2 Dunned Customer', template_name: 'Nudge', template_tone: 'polite',
      sent_at: '2026-01-01T10:00:00Z', sent_to_email: 'a@b.c', rendered_subject: 'x', trigger_source: 'manual', email_status: 'sent',
      email_error: null, response_action: null, response_received_at: null, response_note: null, message_token: 't' }] },
    shows: 'D2 Dunned Customer' },
  { name: 'bank transfers', Page: BankTransfersPage, url: 'chart-of-accounts', plain: /Could not load bank accounts/,
    data: [{ id: 'a1', accountCode: '1100', accountName: 'D2 Transfer Bank' }], shows: 'D2 Transfer Bank' },
  { name: 'credit notes', Page: CreditNotesPage, url: 'credit-notes', plain: /Could not load credit notes/,
    data: { creditNotes: [{ id: 'c1', creditNoteNumber: 'CN-D2-555', type: 'customer', clientName: 'x', creditDate: '2026-01-01', totalAmount: 10, status: 'draft' }], total: 1 },
    shows: 'CN-D2-555' },
  { name: 'goods received', Page: GoodsReceivedPage, url: 'goods-received', plain: /Could not load GRNs/,
    data: [{ id: 'g1', grn_number: 'GRN-D2-321', po_number: null, supplier_name: 'D2 GRN Supplier', received_date: '2026-01-01', received_by: null, notes: null }],
    shows: 'GRN-D2-321' },
  { name: 'customer communication report', Page: CustomerCommunicationReport, url: 'reports/customer-communication', plain: /Could not load the report/,
    data: { records: [{ id: 'r1', customerId: null, customerName: 'D2 Comm Customer', email: 'e@x.c', documentType: 'invoice', subject: 's', sentAt: '2026-01-01T00:00:00Z', status: 'sent' }], total: 1, page: 1, limit: 50 },
    shows: 'D2 Comm Customer' },
  { name: 'sales by customer report', Page: SalesByCustomerReport, url: 'reports/sales-by-customer', plain: /Could not load sales by customer/,
    data: [{ clientId: 'k1', clientName: 'D2 Sales Customer', invoiceCount: 3, totalSales: 100, paymentsReceived: 50, outstanding: 50 }], shows: 'D2 Sales Customer' },
  { name: 'supplier payments', Page: SupplierPaymentsPage, url: 'supplier-payments', plain: /Could not load payments/,
    data: { payments: [{ id: 'p1', paymentNumber: 'PAY-D2-909', supplierName: 'D2 Pay Supplier', paymentDate: '2026-01-01', totalAmount: 5, paymentMethod: 'eft', status: 'draft' }], total: 1 },
    shows: 'PAY-D2-909' },
  { name: 'supplier contacts tab', Page: () => <ContactsTab supplierId="sup-1" />, url: 'supplier-contacts', plain: /Could not load contacts/,
    data: [{ id: 'k1', full_name: 'D2 Contact Person', role: null, email: null, phone: null, is_primary: false }], shows: 'D2 Contact Person' },
];

function script(url: string, main: () => Response) {
  vi.mocked(apiFetch).mockImplementation(async (u: unknown) => (String(u).includes(url) ? main() : ok({})));
}
const bodyText = () => document.body.textContent ?? '';

describe.each(cases)('$name', ({ Page, url, data, shows, plain }) => {
  it('shows the server message on a 400 error envelope', async () => {
    script(url, refused);
    render(<Page />);
    await waitFor(() => expect(bodyText()).toContain(MSG));
  });
  it('shows a plain sentence, not JSON parser text, on an empty 500', async () => {
    script(url, () => new Response('', { status: 500 }));
    render(<Page />);
    await waitFor(() => expect(bodyText()).toMatch(plain));
    expect(bodyText()).not.toMatch(/JSON|Unexpected end/);
  });
  it('renders the data on a 200 envelope', async () => {
    script(url, () => ok(data));
    render(<Page />);
    await waitFor(() => expect(bodyText()).toContain(shows));
  });
});
