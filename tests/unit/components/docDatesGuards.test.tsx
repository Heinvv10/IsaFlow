/**
 * Wave 2 PR A: a date the field refused must not be saved. The pages over 300 lines (purchase-orders/[poId],
 * recurring-invoices/[id], document-capture/[docId]) used to clear the value, which a server then read as
 * "keep the old date" or rejected; journals, item adjustments and bank transactions post through their forms.
 * Each case types a refused date ("zz" + blur, or "zz" + Enter), tries to save, and expects no write; then fixes the
 * date and expects the write.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok } from '../helpers/d2CensusG4';
import { typeDate } from '../helpers/dateFields';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
const route = vi.hoisted(() => ({ query: {} as Record<string, string> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: route.query, push: vi.fn(async () => true), replace: vi.fn(), pathname: '/', isReady: true }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/modules/accounting/documents', () => ({ AccountingDocumentPanel: () => null }));
vi.mock('@/components/accounting/ScanAndFillButton', () => ({ ScanAndFillButton: () => null }));
vi.mock('@/components/accounting/supplier-invoices/SupplierSelect', () => ({ SupplierSelect: () => null }));
vi.mock('@/components/accounting/ap/ThreeWayMatchPanel', () => ({ ThreeWayMatchPanel: () => null }));
vi.mock('@/components/accounting/ap/SupplierInvoiceApprovalPanel', () => ({ SupplierInvoiceApprovalPanel: () => null }));
vi.mock('@/components/accounting/sars/MarkVatDeclaredElsewhereButton', () => ({ MarkVatDeclaredElsewhereButton: () => null }));
vi.mock('@/utils/toast', () => ({ notify: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ activeCompany: { id: 'co-1', name: 'Co' } }) }));
import { apiFetch } from '@/lib/apiFetch';
import PoDetail from '../../../pages/accounting/purchase-orders/[poId]';
import RecurringInvoiceEdit from '../../../pages/accounting/recurring-invoices/[id]';
import DocCapture from '../../../pages/accounting/document-capture/[docId]';
import JournalNew from '../../../pages/accounting/journal-entries/new';
import ItemAdjustments from '../../../pages/accounting/item-adjustments';
import SupplierInvoiceDetail from '../../../pages/accounting/supplier-invoices/[invoiceId]';
import ItemNew from '../../../pages/accounting/items/new';
import CustomerNew from '../../../pages/accounting/customers/new';
import SupplierNew from '../../../pages/accounting/suppliers/new';

useApiJsonOverMock();
let respond: (url: string) => unknown = () => [];
beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async (url: unknown) => ok(respond(String(url)) ?? []));
});
afterEach(cleanup);

const writes = () => vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method && init.method !== 'GET');
const box = (label: string): HTMLInputElement => screen.getByRole('textbox', { name: new RegExp(`^${label}`, 'i') }) as HTMLInputElement;
const click = async (name: RegExp): Promise<void> => { fireEvent.click(await screen.findByRole('button', { name })); };

interface Case { page: string; query: Record<string, string>; ui: JSX.Element; data: (u: string) => unknown;
  open?: () => Promise<void>; field: string; save: () => Promise<void> | void; ready: () => Promise<unknown> }

const cases: Case[] = [
  { page: 'purchase-orders/[poId]', query: { poId: 'po-1' }, ui: <PoDetail />, field: 'Order Date',
    data: (u) => (u.endsWith('purchase-orders/po-1') ? { id: 'po-1', po_number: 'PO-1', status: 'draft', supplier_id: 's1', order_date: '2026-10-01', expected_delivery_date: null, items: [] } : undefined),
    open: async () => { await click(/^edit$/i); }, save: () => click(/save changes/i), ready: () => screen.findByRole('textbox', { name: /^order date/i }) },
  { page: 'recurring-invoices/[id]', query: { id: 'ri-1' }, ui: <RecurringInvoiceEdit />, field: 'Next Run Date',
    data: (u) => (u.endsWith('recurring-invoices') ? { items: [{ id: 'ri-1', templateName: 'T', clientId: 'c1', frequency: 'monthly', nextRunDate: '2026-11-01', lineItems: [{ description: 'Fee', quantity: 1, unitPrice: 10 }] }] } : undefined),
    save: () => { fireEvent.submit(document.querySelector('form')!); }, ready: () => screen.findByDisplayValue('Fee') },
  { page: 'document-capture/[docId]', query: { docId: 'doc-1' }, ui: <DocCapture />, field: 'Date',
    data: (u) => (u.includes('document-capture?id=doc-1') ? { id: 'doc-1', status: 'pending', readState: 'done', documentDate: '2026-10-01', extractedData: null, vendorName: 'V' } : undefined),
    save: () => click(/confirm/i), ready: () => screen.findByRole('textbox', { name: /^date/i }) },
  { page: 'journal-entries/new', query: {}, ui: <JournalNew />, field: 'Entry Date',
    data: (u) => (u.includes('chart-of-accounts') ? [{ id: 'a1', accountCode: '1000', accountName: 'Bank', isActive: true }, { id: 'a2', accountCode: '2000', accountName: 'Loan', isActive: true }] : undefined),
    save: () => { fireEvent.submit(document.querySelector('form')!); },
    ready: async () => {
      await screen.findAllByRole('option', { name: /1000 - Bank/ });
      const accts = screen.getAllByLabelText('Account');
      fireEvent.change(accts[0]!, { target: { value: 'a1' } });
      fireEvent.change(accts[1]!, { target: { value: 'a2' } });
      const amounts = screen.getAllByPlaceholderText('0.00');
      fireEvent.change(amounts[0]!, { target: { value: '10' } });
      fireEvent.change(amounts[3]!, { target: { value: '10' } });
    } },
  { page: 'item-adjustments', query: {}, ui: <ItemAdjustments />, field: 'Date',
    data: () => undefined, open: async () => { await click(/new adjustment|adjust/i); },
    save: () => { fireEvent.submit(document.querySelector('form')!); }, ready: () => screen.findByRole('textbox', { name: /^date/i }) },
  { page: 'supplier-invoices/[invoiceId]', query: { invoiceId: 'si-1' }, ui: <SupplierInvoiceDetail />, field: 'Due Date',
    data: (u) => (u.includes('supplier-invoices-detail') ? { id: 'si-1', invoiceNumber: 'SI-1', status: 'draft', supplierName: 'Acme', dueDate: '2026-10-31', invoiceDate: '2026-10-01', items: [], subtotal: 0, taxAmount: 0, totalAmount: 0, balance: 0, approval: null } : undefined),
    open: async () => { await click(/^edit$/i); }, save: () => click(/^save$/i), ready: () => screen.findByRole('textbox', { name: /^due date/i }) },
  { page: 'items/new', query: {}, ui: <ItemNew />, field: 'Opening Date',
    data: () => undefined, save: () => { fireEvent.submit(document.querySelector('form')!); }, ready: () => screen.findByRole('textbox', { name: /^opening date/i }) },
];

describe.each(cases)('$page', (c) => {
  it.each(['blur', 'enter'] as const)('does not save a refused date (%s), then saves the fixed one', async (how) => {
    route.query = c.query;
    respond = c.data;
    render(c.ui);
    await c.open?.();
    await c.ready();
    const input = box(c.field);
    if (how === 'blur') typeDate(input, 'zz');
    else { fireEvent.change(input, { target: { value: 'zz' } }); fireEvent.keyDown(input, { key: 'Enter' }); }
    await c.save();
    expect(writes()).toHaveLength(0);
    typeDate(box(c.field), '6 Oct 2031');
    await c.save();
    await waitFor(() => expect(writes().length).toBeGreaterThan(0));
  });
});

describe.each([['customers/new', <CustomerNew />, 'e\\.g\\. Acme Corporation'], ['suppliers/new', <SupplierNew />, 'ABC Supplies']] as const)('%s', (_p, ui, nameLabel) => {
  it('does not create while the opening balance date is refused', async () => {
    respond = () => [];
    route.query = {};
    render(ui);
    fireEvent.change(await screen.findByPlaceholderText(new RegExp(nameLabel)), { target: { value: 'Acme' } });
    typeDate(box('Opening Balance as At'), 'zz');
    fireEvent.submit(document.querySelector('form')!);
    expect(writes()).toHaveLength(0);
    typeDate(box('Opening Balance as At'), '6 Oct 2031');
    fireEvent.submit(document.querySelector('form')!);
    await waitFor(() => expect(writes().length).toBeGreaterThan(0));
  });
});
