/**
 * D2 census, group 3a: reference-data loads and one action that called `res.json()` on an unchecked
 * apiFetch response. Per site: a 400 with the real error envelope shows the server's message; a 500 with
 * an EMPTY body shows a plain sentence (never "JSON" / "Unexpected end"); a 200 envelope renders its data.
 * The real apiFetch helpers (assertOk / apiErrorMessage) run on top of the mocked apiFetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { creditNoteId: 'cn1', docId: 'd1' }, isReady: true, push: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/modules/accounting/documents', () => ({ AccountingDocumentPanel: () => null }));
vi.mock('@/utils/toast', () => ({ notify: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

import { apiFetch } from '@/lib/apiFetch';
import { notify } from '@/utils/toast';
import AssetNewPage from '../../../pages/accounting/assets/new';
import CreditNoteDetailPage from '../../../pages/accounting/credit-notes/[creditNoteId]';
import CustomerQuotesPage from '../../../pages/accounting/customer-quotes/index';
import DocumentCaptureDetailPage from '../../../pages/accounting/document-capture/[docId]';
import GroupIncomeStatementPage from '../../../pages/accounting/group/income-statement';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const MSG = 'D2 server says no: this data is not available';
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const refuse = () => new Response(JSON.stringify({ success: false, error: { code: 'BAD_REQUEST', message: MSG } }), { status: 400 });
const emptyBody = () => new Response('', { status: 500 });
const NO_JSON = /JSON|Unexpected end/;
const SECTION = { entities: {}, elimination: 0, consolidated: 0 };
const IS = { rows: [], entityNames: {}, totalRevenue: SECTION, totalCostOfSales: SECTION, grossProfit: SECTION, totalOperatingExpenses: SECTION, netProfit: SECTION };

interface Site { name: string; ui: () => ReactElement; fails: string; rest?: () => Response; good: unknown; shows: RegExp; plain: RegExp }
const sites: Site[] = [
  { name: 'assets/new: categories', ui: () => <AssetNewPage />, fails: '/assets-categories', good: [{ id: 'c1', name: 'D2 Vehicles', code: 'VEH', sars_rate: 20, sars_years: 5, description: '' }],
    shows: /D2 Vehicles/, plain: /Could not load asset categories - try again/ },
  { name: 'credit note detail: the note', ui: () => <CreditNoteDetailPage />, fails: '/credit-notes?id=', good: { id: 'cn1', creditNoteNumber: 'D2-CN-1', type: 'customer', clientName: 'D2 Client',
    creditDate: '2026-01-01', subtotal: 10, taxRate: 15, taxAmount: 1.5, totalAmount: 11.5, status: 'draft', createdAt: '2026-01-01' }, shows: /D2-CN-1/, plain: /Could not load the credit note - try again/ },
  { name: 'customer quotes: customer list', ui: () => <CustomerQuotesPage />, fails: '/api/accounting/customers', rest: () => ok({ quotes: [], total: 0 }),
    good: [{ id: 'k1', name: 'D2 Customer Ltd' }], shows: /D2 Customer Ltd/, plain: /Could not load customers - try again/ },
  { name: 'group income statement: group list', ui: () => <GroupIncomeStatementPage />, fails: '/company-groups', rest: () => ok(IS),
    good: [{ id: 'g1', name: 'D2 Holdings Group' }], shows: /D2 Holdings Group/, plain: /Could not load the company groups - try again/ },
];

function script(s: Site, answer: () => Response) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => (String(url).includes(s.fails) ? answer() : (s.rest ?? (() => ok({})))()));
}

describe.each(sites)('$name', (s) => {
  it('400: the server message is shown', async () => {
    script(s, refuse);
    render(s.ui());
    expect(await screen.findByText(MSG, { exact: false })).toBeTruthy();
  });

  it('500 with an empty body: a plain sentence, not a JSON parse error', async () => {
    script(s, emptyBody);
    render(s.ui());
    expect(await screen.findByText(s.plain)).toBeTruthy();
    expect(screen.queryByText(NO_JSON)).toBeNull();
  });

  it('200: the data renders', async () => {
    script(s, () => ok(s.good));
    render(s.ui());
    if (s.name.startsWith('customer quotes')) fireEvent.click(await screen.findByRole('button', { name: /New Quote/ }));
    expect((await screen.findAllByText(s.shows)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Could not load|D2 server says no/)).toBeNull();
  });
});

describe('customer quotes: convert to invoice', () => {
  const QUOTE = { id: 'q1', quoteNumber: 'D2-Q-1', customerName: 'D2 Customer', quoteDate: '2026-01-01', expiryDate: null, status: 'accepted', total: 10 };
  const alertSpy = vi.fn();
  beforeEach(() => {
    alertSpy.mockReset();
    vi.stubGlobal('alert', alertSpy);
    vi.stubGlobal('confirm', () => true);
  });
  const run = async (answer: () => Response) => {
    vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => (String(url).includes('customer-quotes-action') ? answer() : ok({ quotes: [QUOTE], total: 1 })));
    render(<CustomerQuotesPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^Invoice$/ }));
  };

  it('400: the server message is shown', async () => {
    await run(refuse);
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith(MSG));
  });

  it('500 with an empty body: a plain sentence, not a JSON parse error', async () => {
    await run(emptyBody);
    await waitFor(() => expect(alertSpy).toHaveBeenCalledTimes(1));
    const shown = String(alertSpy.mock.calls[0]?.[0]);
    expect(shown).toBe('Failed to convert');
    expect(shown).not.toMatch(NO_JSON);
  });

  it('200: the quote is reported as converted', async () => {
    await run(() => ok({ invoiceId: 'inv-d2' }));
    expect(await screen.findByText(/D2-Q-1 converted\./)).toBeTruthy();
    expect(alertSpy).not.toHaveBeenCalled();
  });
});

describe('document capture: confirm', () => {
  const DOC = { id: 'd1', fileName: 'd2-scan.pdf', fileType: 'pdf', fileSize: 1024, documentType: 'invoice', extractedData: null, vendorName: 'D2 Vendor',
    documentDate: '2026-01-01', referenceNumber: 'R1', totalAmount: 10, vatAmount: 1, status: 'pending', matchedInvoiceId: null, matchedBankTxId: null,
    notes: null, uploadedBy: null, createdAt: '2026-01-01T00:00:00Z' };
  const run = async (answer: () => Response) => {
    vi.mocked(notify.error).mockClear(); vi.mocked(notify.success).mockClear();
    vi.mocked(apiFetch).mockReset().mockImplementation(async (url, init) => (String(url).includes('document-capture-action') && init?.method === 'POST' ? answer() : ok(DOC)));
    render(<DocumentCaptureDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Confirm & Save/ }));
  };

  it('400: the server message reaches the toast', async () => {
    await run(refuse);
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith(MSG));
  });

  it('500 with an empty body: a plain sentence, not a JSON parse error', async () => {
    await run(emptyBody);
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith('Could not confirm the document - try again'));
    expect(vi.mocked(notify.error).mock.calls.flat().join(' ')).not.toMatch(NO_JSON);
  });

  it('200: the document is confirmed', async () => {
    await run(() => ok({}));
    await waitFor(() => expect(notify.success).toHaveBeenCalledWith('Document confirmed'));
    expect(notify.error).not.toHaveBeenCalled();
  });
});
