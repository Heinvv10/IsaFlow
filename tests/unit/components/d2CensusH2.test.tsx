/**
 * D2 census group 2: the load of these pages used to call res.json() with no ok check, so a 400 left an empty
 * view and an empty-body 500 threw "Unexpected end of JSON input". Each case answers one request with (1) the real
 * error envelope, (2) an empty-body 500, (3) a good 200 that must render. REAL assertOk / apiErrorMessage.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, render, screen } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => router }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/ScanAndFillButton', () => ({ ScanAndFillButton: () => null }));
vi.mock('@/components/accounting/DescriptionAutocomplete', () => ({ DescriptionAutocomplete: () => null }));
vi.mock('@/utils/toast', () => ({ notify: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
const router = vi.hoisted(() => ({ query: { clientId: 'c1', customer_id: 'c1', id: 'rec1' }, isReady: true, asPath: '/', push: vi.fn(), replace: vi.fn() }));

import { apiFetch } from '@/lib/apiFetch';
import AccountingSettingsPage from '../../../pages/accounting/accounting-settings';
import AssetDisposalsPage from '../../../pages/accounting/assets/disposals';
import NewCustomerPaymentPage from '../../../pages/accounting/customer-payments/new';
import NewDeliveryNotePage from '../../../pages/accounting/delivery-notes/new';
import EliminationsPage from '../../../pages/accounting/group/eliminations';
import NewJournalEntryPage from '../../../pages/accounting/journal-entries/new';
import EditRecurringInvoicePage from '../../../pages/accounting/recurring-invoices/[id]';
import StatementsPage from '../../../pages/accounting/statements/index';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
afterEach(() => { cleanup(); });

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const bad = (m: string) => new Response(JSON.stringify({ success: false, error: { code: 'BAD_REQUEST', message: m } }), { status: 400 });
const empty500 = () => new Response('', { status: 500 });
const MSG = 'D2 server says no: this data is not available';

const REC = { id: 'rec1', templateName: 'D2 Template', clientId: 'c1', frequency: 'monthly', nextRunDate: '2027-01-01',
  lineItems: [{ description: 'D2 line', quantity: 1, unitPrice: 5 }] };
const STMT = { customers: [{ client_id: 'c1', client_name: 'D2 Debtor Co', total_invoiced: 100, total_paid: 0, balance: 100, invoice_count: 1 }] };
const text = (re: RegExp) => () => screen.findAllByText(re);

interface Case {
  name: string;
  page: () => JSX.Element;
  fails: (url: string) => boolean;
  good: unknown;
  /** Answers every other request; default is an empty list. */
  rest?: (url: string) => unknown;
  shows: () => Promise<unknown>;
  plain: RegExp;
}

const CASES: Case[] = [
  { name: 'accounting settings: auto-post card', page: () => <AccountingSettingsPage />, fails: u => u.includes('bank-auto-post'),
    good: { settings: { enabled: true, minConfidence: 0.77, amountCap: 12345, llmEnabled: false, llmMinConfidence: 0.95, llmAmountCap: 2000 } },
    rest: u => (u.includes('accounting-settings') ? { value: '' } : []), shows: () => screen.findByDisplayValue('0.77'),
    plain: /Could not load auto-post settings - try again/ },
  { name: 'asset disposals', page: () => <AssetDisposalsPage />, fails: () => true,
    good: [{ id: 'd1', asset_number: 'FA-D2-1', asset_name: 'D2 Excavator', category: 'x', disposal_date: '2026-01-01T00:00:00Z',
      disposal_method: 'sale', disposal_amount: 1, book_value_at_disposal: 1, gain_loss: 0 }],
    shows: text(/D2 Excavator/), plain: /Could not load asset disposals - try again/ },
  { name: 'customer payment: outstanding invoices', page: () => <NewCustomerPaymentPage />, fails: u => u.includes('customer-invoices-list'),
    good: { invoices: [{ id: 'i1', invoice_number: 'INV-D2-1', total_amount: 100, amount_paid: 0 }] },
    shows: text(/INV-D2-1/), plain: /Could not load outstanding invoices - try again/ },
  { name: 'delivery note: customers', page: () => <NewDeliveryNotePage />, fails: u => u.endsWith('/customers'),
    good: [{ id: 'c1', name: 'D2 Customer' }], shows: text(/D2 Customer/), plain: /Could not load customers - try again/ },
  { name: 'delivery note: sales orders', page: () => <NewDeliveryNotePage />, fails: u => u.includes('customer-sales-orders'),
    good: { orders: [{ id: 'so1', orderNumber: 'SO-D2-1' }] }, shows: text(/SO-D2-1/), plain: /Could not load sales orders - try again/ },
  { name: 'eliminations: company groups', page: () => <EliminationsPage />, fails: u => u.endsWith('/company-groups'),
    good: [{ id: 'g1', name: 'D2 Group Alpha' }], shows: text(/D2 Group Alpha/), plain: /Could not load company groups - try again/ },
  { name: 'journal entry: accounts', page: () => <NewJournalEntryPage />, fails: u => u.endsWith('/chart-of-accounts'),
    good: [{ id: 'a1', accountCode: '1D2X', accountName: 'D2 Bank', isActive: true }], shows: text(/1D2X - D2 Bank/),
    plain: /Could not load accounts - try again/ },
  { name: 'recurring invoice: customers', page: () => <EditRecurringInvoicePage />, fails: u => u.endsWith('/customers'),
    good: [{ id: 'c1', company_name: 'D2 Customer Ltd' }], rest: u => (u.endsWith('/recurring-invoices') ? { items: [REC] } : []),
    shows: text(/D2 Customer Ltd/), plain: /Could not load customers - try again/ },
  { name: 'recurring invoice: the invoice', page: () => <EditRecurringInvoicePage />, fails: u => u.endsWith('/recurring-invoices'),
    good: { items: [REC] }, shows: () => screen.findByDisplayValue('D2 Template'), plain: /Could not load the recurring invoice - try again/ },
  { name: 'statements: balances', page: () => <StatementsPage />, fails: u => u.includes('customer-statements?'),
    good: STMT, shows: text(/D2 Debtor Co/), plain: /Could not load the customer data - try again/ },
  { name: 'statements: customer list', page: () => <StatementsPage />, fails: u => u.includes('/customers?limit'),
    good: [], rest: u => (u.includes('customer-statements?') ? STMT : []), shows: text(/D2 Debtor Co/), plain: /Could not load the customer data - try again/ },
  { name: 'statements: aging', page: () => <StatementsPage />, fails: u => u.includes('ar-aging'),
    good: [], rest: u => (u.includes('customer-statements?') ? STMT : []), shows: text(/D2 Debtor Co/), plain: /Could not load the customer data - try again/ },
];

function script(c: Case, answer: () => Response) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => {
    const u = String(url);
    return c.fails(u) ? answer() : ok(c.rest ? c.rest(u) : []);
  });
}

describe.each(CASES)('$name', (c) => {
  it('400: the server message is shown', async () => {
    script(c, () => bad(MSG));
    render(c.page());
    expect(await screen.findByText(new RegExp(MSG))).toBeTruthy();
  });

  it('500 with an empty body: a plain sentence, not a JSON parse error', async () => {
    script(c, empty500);
    render(c.page());
    expect(await screen.findByText(c.plain)).toBeTruthy();
    expect(screen.queryByText(/JSON|Unexpected end/)).toBeNull();
  });

  it('200: the data renders and no error shows', async () => {
    script(c, () => ok(c.good));
    render(c.page());
    expect(await c.shows()).toBeTruthy();
    expect(screen.queryByText(/Could not load|Failed to load|D2 server says no/)).toBeNull();
  });
});
