/**
 * D2 census, group 1b: multi-request pages whose load called `res.json()` on an unchecked apiFetch response.
 * Per site: a 400 with the real error envelope shows the server's message; a 500 with an EMPTY body shows a
 * plain sentence (never "JSON" / "Unexpected end"); a 200 envelope still renders its data. The real
 * apiFetch helpers run on top of the mocked apiFetch; only the failing request differs per case.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

const mocks = vi.hoisted(() => ({ query: {} as Record<string, string> }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: mocks.query, isReady: true, push: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ activeCompany: { id: 'co1' }, loading: false }) }));
vi.mock('@/components/accounting/supplier-invoices/SupplierSelect', () => ({ SupplierSelect: () => <span /> }));
vi.mock('@/components/accounting/RecordNavigation', () => ({ RecordNavigation: () => <span /> }));
vi.mock('@/components/accounting/customers/DeliveryAddressesTab', () => ({ DeliveryAddressesTab: () => <span /> }));
vi.mock('@/components/accounting/customers/ContactsTab', () => ({ ContactsTab: () => <span /> }));
vi.mock('@/components/accounting/settings/SettingsSidebar', () => ({ SettingsSidebar: () => <span /> }));
vi.mock('@/components/accounting/settings/DimensionSettings', () => ({ DimensionSettings: () => <span /> }));
vi.mock('@/components/accounting/settings/GeneralTab', () => ({
  GeneralTab: ({ company }: { company: { name: string } }) => <p>{company.name}</p>,
}));
vi.mock('@/components/accounting/settings/DocumentsTab', () => ({
  DocumentsTab: ({ docNumbers }: { docNumbers: { prefix: string }[] }) => <p>{docNumbers.map(d => d.prefix).join(',')}</p>,
}));

import { apiFetch } from '@/lib/apiFetch';
import ReceiptMatchQueuePage from '../../../pages/accounting/ar/receipt-match/index';
import NewBatchPaymentPage from '../../../pages/accounting/batch-payments/new';
import CompanySettingsPage from '../../../pages/accounting/company-settings';
import CustomerDetailPage from '../../../pages/accounting/customers/[customerId]';
import RateCurvesPage from '../../../pages/accounting/loans/rate-curves';

useApiJsonOverMock();
afterEach(() => { cleanup(); mocks.query = {}; });

const MSG = 'D2 server says no: this period is locked';
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const refuse = () => new Response(JSON.stringify({ success: false, error: { code: 'BAD_REQUEST', message: MSG } }), { status: 400 });
const emptyBody = () => new Response('', { status: 500 });

interface Site {
  name: string; ui: () => ReactElement; query?: Record<string, string>;
  fails: (url: string) => boolean; plain: string; good: () => Response; shows: string;
  others?: (url: string) => Response | undefined; before?: () => void;
}
// valid empty answers for the company-settings page's other mount requests
const settingsEmpty = (u: string) => (u.includes('/companies?id=') ? ok({ id: 'co1', name: 'D2 Co' })
  : u.includes('accounting-settings') ? ok({ key: 'document_display_fields', value: null }) : ok([]));
const tx = { id: 't1', transactionDate: '2026-01-01', amount: 100, description: 'D2 receipt from Acme', reference: 'R1' };
const cust = { id: 'c1', name: 'D2 Customer Ltd', is_active: true, created_at: '2026-01-01' };
const sites: Site[] = [
  { name: 'receipt-match: receipts list', ui: () => <ReceiptMatchQueuePage />, fails: u => u.includes('/bank-transactions?'),
    plain: 'Could not load receipts - try again', good: () => ok({ transactions: [tx] }), shows: 'D2 receipt from Acme' },
  { name: 'receipt-match: shortlist', ui: () => <ReceiptMatchQueuePage />, fails: u => u.includes('/ar/receipt-match/t1'),
    plain: 'Could not load match suggestions - try again',
    good: () => ok({ candidates: [{ type: 'customer_invoice', id: 'c1', label: 'D2-INV-77', amount: 100, date: '2026-01-01', score: 90 }] }), shows: 'D2-INV-77',
    others: u => (u.includes('/bank-transactions?') ? ok({ transactions: [tx] }) : undefined) },
  { name: 'batch-payments/new: invoices', ui: () => <NewBatchPaymentPage />, fails: u => u.includes('/supplier-invoices?'),
    plain: 'Could not load supplier invoices - try again',
    good: () => ok([{ id: 'i1', invoiceNumber: 'D2-BILL-1', totalAmount: 500, amountPaid: 0, supplierId: 's1' }]), shows: 'D2-BILL-1' },
  { name: 'company-settings: company', ui: () => <CompanySettingsPage />, query: { tab: 'general' }, fails: u => u.includes('/companies?id='),
    plain: 'Could not load company - try again', good: () => ok({ id: 'co1', name: 'D2 Company (Pty) Ltd' }), shows: 'D2 Company (Pty) Ltd',
    others: settingsEmpty },
  { name: 'company-settings: document numbers', ui: () => <CompanySettingsPage />, query: { tab: 'documents' }, fails: u => u.includes('type=document-numbers'),
    plain: 'Could not load some company settings - try again', good: () => ok([{ documentType: 'invoice', prefix: 'D2PFX', nextNumber: 1 }]), shows: 'D2PFX',
    others: settingsEmpty },
  { name: 'customers/[id]: customer', ui: () => <CustomerDetailPage />, query: { customerId: 'c1' }, fails: u => u.includes('/customers?id=c1') && !u.includes('include='),
    plain: 'Could not load customer - try again', good: () => ok(cust), shows: 'D2 Customer Ltd' },
  { name: 'customers/[id]: activity tab', ui: () => <CustomerDetailPage />, query: { customerId: 'c1' }, fails: u => u.includes('include=activity'),
    plain: 'Could not load activity - try again', good: () => ok([{ id: 'r1', reference: 'D2-ACT-1', date: '2026-01-01', total_amount: 10, status: 'paid', type: 'invoice' }]), shows: 'D2-ACT-1',
    others: u => (u.includes('/customers?id=c1') ? ok(cust) : undefined),
    before: () => { fireEvent.click(screen.getByRole('button', { name: /Activity/ })); } },
  { name: 'rate-curves: curves', ui: () => <RateCurvesPage />, fails: u => u.endsWith('/loan-rate-curves'),
    plain: 'Could not load rate curves - try again', good: () => ok([{ id: 'k1', name: 'D2 Prime Curve' }]), shows: 'D2 Prime Curve' },
  { name: 'rate-curves: points', ui: () => <RateCurvesPage />, fails: u => u.includes('/points'),
    plain: 'Could not load rate points - try again', good: () => ok([{ effectiveDate: '2026-01-01', rate: 11.75 }]), shows: '11.7500',
    others: u => (u.endsWith('/loan-rate-curves') ? ok([{ id: 'k1', name: 'D2 Prime Curve' }]) : undefined),
    before: () => { fireEvent.click(screen.getByRole('button', { name: /D2 Prime Curve/ })); } },
];

async function open(s: Site, answer: () => Response) {
  mocks.query = s.query ?? {};
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => {
    const u = String(url);
    return s.fails(u) ? answer() : (s.others?.(u) ?? ok({}));
  });
  const view = render(s.ui());
  if (s.before) {
    // the follow-up click needs the first load's result on screen (customer name / curve row)
    await screen.findByRole('button', { name: s.name.includes('points') ? /D2 Prime Curve/ : /Activity/ });
    s.before();
  }
  return view;
}

describe.each(sites)('D2 census 1b: $name', (s) => {
  it('400: the server message from the error envelope is shown', async () => {
    await open(s, refuse);
    expect(await screen.findByText(MSG, { exact: false })).toBeTruthy();
  });

  it('500 with an empty body: a plain sentence is shown, not a JSON parse error', async () => {
    const { container } = await open(s, emptyBody);
    expect(await screen.findByText(s.plain, { exact: false })).toBeTruthy();
    expect(container.textContent).not.toMatch(/JSON|Unexpected end/i);
  });

  it('200: the data renders', async () => {
    await open(s, s.good);
    expect((await screen.findAllByText(s.shows, { exact: false })).length).toBeGreaterThan(0);
  });
});
