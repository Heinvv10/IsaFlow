// D2 round 6 (h4): a failed (re)load clears what was on screen. Invoice detail: a failed reload after Approve must
// not show the pre-action draft with its Approve button; cashbook: no stale rows under the error; compliance:
// a failed load never renders blank/default toggles that Save would write back.
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

configure({ asyncUtilTimeout: 4000 });
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { invoiceId: 'inv-1' }, push: vi.fn(), replace: vi.fn(), pathname: '/', isReady: true }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/modules/accounting/documents', () => ({ AccountingDocumentPanel: () => null }));
vi.mock('@/components/accounting/sars/MarkVatDeclaredElsewhereButton', () => ({ MarkVatDeclaredElsewhereButton: () => null }));
vi.mock('@/components/invoices/CustomerInvoiceSummary', () => ({ CustomerInvoiceSummary: () => null }));
vi.mock('@/components/ui/ConfirmDialog', () => ({ ConfirmDialog: () => null }));
vi.mock('@/modules/accounting/utils/payNowCheckout', () => ({ startPayNowCheckout: vi.fn() }));

import { apiFetch } from '@/lib/apiFetch';
import InvoiceDetailPage from '../../../pages/accounting/customer-invoices/[invoiceId]';
import CashbookPage from '../../../pages/accounting/cashbook';
import { ComplianceTab } from '../../../src/components/accounting/settings/ComplianceTab';
import { typeDate } from '../../helpers/typeDate';

useApiJsonOverMock();
const MSG = 'D2 server says no: this request was refused';
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const bad400 = () => new Response(JSON.stringify({ success: false, error: { code: 'BAD_REQUEST', message: MSG } }), { status: 400 });
const empty500 = () => new Response('', { status: 500 });
const noRaw = () => expect(document.body.textContent ?? '').not.toMatch(/JSON|Unexpected end|HTTP \d|Failed to/);
const route = (fn: (u: string, m: string) => Response) => vi.mocked(apiFetch).mockReset().mockImplementation(async (u, i) => fn(String(u), (i?.method ?? 'GET').toUpperCase()));
beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(() => { cleanup(); });

const INV = { id: 'inv-1', invoice_number: 'INV-D2-777', client_name: 'Acme', project_name: 'P', status: 'draft', total_amount: 100, amount_paid: 0, items: [] };

describe('customer invoice detail', () => {
  it('a failed reload after Approve clears the invoice: no pre-action draft, no Approve button', async () => {
    let gets = 0;
    route((u, m) => {
      if (u.includes('adjacent')) return ok({ prevId: 'inv-0', nextId: null });
      if (u.includes('customer-invoices-detail') && m === 'GET') return ++gets > 1 ? empty500() : ok(INV);
      return ok({});
    });
    render(<InvoiceDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^approve$/i }));
    expect(await screen.findByText('Could not load the invoice - try again')).toBeTruthy();
    expect(screen.queryByText('INV-D2-777')).toBeNull();
    expect(screen.queryByRole('button', { name: /^approve$/i })).toBeNull();
    expect(screen.queryByTitle('Previous invoice')).toBeNull();
    noRaw();
  });
  it('a 400 on the first load shows the server message', async () => {
    route(u => (u.includes('adjacent') ? ok({ prevId: null, nextId: null }) : bad400()));
    render(<InvoiceDetailPage />);
    expect(await screen.findByText(MSG)).toBeTruthy();
  });
});

const BANK = [{ id: 'b1', accountCode: '1000', accountName: 'D2 Cheque', balance: 0 }];
const TX = [{ id: 't1', transactionDate: '2031-02-01', reference: 'REF-D2', description: 'D2 deposit', amount: 500, status: 'matched' }];

describe('cashbook', () => {
  it('a failed reload clears the rows and says why', async () => {
    let txCalls = 0;
    route(u => (u.includes('bank-accounts') ? ok(BANK) : ++txCalls > 1 ? bad400() : ok(TX)));
    const { container } = render(<CashbookPage />);
    expect(await screen.findByText('D2 deposit')).toBeTruthy();
    typeDate(container.querySelectorAll('input[placeholder="dd MMM yyyy"]')[0]!, '2031-01-01');
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(screen.queryByText('D2 deposit')).toBeNull();
    expect(screen.getByText(/0 transactions/)).toBeTruthy();
  });
  it('the bank-account list shows the server 4xx message, or a sentence for an empty 500', async () => {
    route(u => (u.includes('bank-accounts') ? bad400() : ok([])));
    render(<CashbookPage />);
    expect(await screen.findByText(MSG)).toBeTruthy(); cleanup();
    route(u => (u.includes('bank-accounts') ? empty500() : ok([])));
    render(<CashbookPage />);
    expect(await screen.findByText('Could not load the bank accounts - try again')).toBeTruthy(); noRaw();
  });
});

describe('compliance obligations', () => {
  it('a failed load shows the reason and no Save button / default toggles', async () => {
    route(() => bad400());
    render(<ComplianceTab />);
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /save obligations/i })).toBeNull();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    cleanup(); route(() => empty500()); render(<ComplianceTab />);
    expect(await screen.findByText('Could not load the compliance obligations - try again')).toBeTruthy(); noRaw();
  });
  it('a good load renders the toggles and Save', async () => {
    route(() => ok({ vatEnabled: true, yearEndMonth: 2 }));
    render(<ComplianceTab />);
    await waitFor(() => expect(screen.getByRole('button', { name: /save obligations/i })).toBeTruthy());
    expect(screen.queryAllByRole('checkbox').length).toBeGreaterThan(0);
  });
});
