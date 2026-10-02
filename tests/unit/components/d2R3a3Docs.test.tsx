/**
 * D2 round 3 (a3): customer statement (search + preview), credit-note detail actions, customer-invoice detail
 * actions (approve, email, portal link). Status is checked BEFORE the body: a 400 shows the server's message, an
 * empty-body 500 a plain sentence (never a JSON parse error), a 200 takes effect.
 */
import { cleanup, configure, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

const q: { current: Record<string, string> } = { current: {} };
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: q.current, push: vi.fn(), replace: vi.fn(), pathname: '/' }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/modules/accounting/documents', () => ({ AccountingDocumentPanel: () => null }));
vi.mock('@/components/accounting/sars/MarkVatDeclaredElsewhereButton', () => ({ MarkVatDeclaredElsewhereButton: () => null }));
vi.mock('@/components/invoices/CustomerInvoiceSummary', () => ({ CustomerInvoiceSummary: () => null }));
vi.mock('@/components/ui/ConfirmDialog', () => ({ ConfirmDialog: () => null }));
vi.mock('@/modules/accounting/utils/statementPdf', () => ({ generateStatementPdf: vi.fn().mockRejectedValue(new Error('pdfkit exploded internally')) }));
vi.mock('@/modules/accounting/utils/payNowCheckout', () => ({ startPayNowCheckout: vi.fn() }));

import { ApiRequestError, apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { startPayNowCheckout } from '@/modules/accounting/utils/payNowCheckout';
import StatementPage from '../../../pages/accounting/customers/statement';
import CreditNotePage from '../../../pages/accounting/credit-notes/[creditNoteId]';
import InvoiceDetailPage from '../../../pages/accounting/customer-invoices/[invoiceId]';
import { boom, expectNoRawJsonError, ok, MSG } from '../helpers/d2CensusG4';
import { trio3 } from '../helpers/d2R3a3';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const isGet = (init?: RequestInit) => !init?.method || init.method === 'GET';
const clickBtn = async (name: RegExp) => fireEvent.click(await screen.findByRole('button', { name }));

const CUST = { id: 'c-1', name: 'D2 Statement Customer', email: 'c@d2.co.za' };
const STMT = { customer: CUST, fromDate: '2031-01-01', toDate: '2031-12-31', transactions: [{ id: 't1', date: '2031-02-01', type: 'invoice', reference: 'INV-D2-STMT',
  description: 'x', debit: 10, credit: 0, balance: 10 }], summary: { openingBalance: 0, totalInvoiced: 10, totalPaid: 0, totalCredits: 0, balance: 10 } };
const stmtOthers = (u: string) => (u.includes('/customers?q=') ? ok([CUST]) : undefined);
const search = async () => { fireEvent.change(screen.getByPlaceholderText('Type to search...'), { target: { value: 'D2' } }); };
const pick = async () => { await search(); fireEvent.click(await screen.findByText('D2 Statement Customer', { selector: 'button' })); };

describe('customers/statement', () => {
  trio3({ name: 'customer search', render: () => render(<StatementPage />), drive: search, match: u => u.includes('/customers?q='), data: [CUST],
    plain: 'Could not search customers - try again', succeeds: async () => { expect(await screen.findByRole('button', { name: /D2 Statement Customer/ })).toBeTruthy(); } });
  trio3({ name: 'statement preview', render: () => render(<StatementPage />), drive: async () => { await pick(); await clickBtn(/preview statement/i); },
    match: u => u.includes('customer-statement?'), data: STMT, others: stmtOthers, plain: 'Could not load the statement - try again',
    succeeds: async () => { expect(await screen.findByText('INV-D2-STMT')).toBeTruthy(); },
    stays: () => { expect(screen.queryByText('INV-D2-STMT')).toBeNull(); } });
});

describe('customers/statement PDF', () => {
  it('a PDF generation crash shows a plain sentence, not the internal error text', async () => {
    vi.mocked(apiFetch).mockReset().mockImplementation(async (url: unknown) => {
      const u = String(url);
      return u.includes('/customers?q=') ? ok([CUST]) : u.includes('customer-statement?') ? ok(STMT) : ok({});
    });
    render(<StatementPage />);
    await pick(); await clickBtn(/preview statement/i); await clickBtn(/download pdf/i);
    expect(await screen.findByText('Could not generate the PDF - try again')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/pdfkit/);
  });
});

const NOTE = { id: 'cn-1', creditNoteNumber: 'CN-D2', type: 'customer', clientId: 'c-1', clientName: 'Acme', creditDate: '2031-03-01', subtotal: 100, taxRate: 15,
  taxAmount: 15, totalAmount: 115, status: 'draft', createdAt: '2031-03-01' };

describe('credit-notes detail action', () => {
  q.current = { creditNoteId: 'cn-1' };
  trio3({ name: 'approve credit note', render: () => { q.current = { creditNoteId: 'cn-1' }; return render(<CreditNotePage />); },
    drive: async () => { await clickBtn(/approve & post gl/i); }, match: (u, i) => u.includes('credit-notes-action') && i?.method === 'POST',
    data: { ...NOTE, status: 'approved' }, others: u => (u.includes('credit-notes?id=') ? ok(NOTE) : undefined), plain: 'Could not complete that action - try again',
    succeeds: async () => { expect(await screen.findByText('approved')).toBeTruthy(); expect(screen.queryByRole('button', { name: /approve & post gl/i })).toBeNull(); },
    stays: () => { expect(screen.getByRole('button', { name: /approve & post gl/i })).toBeTruthy(); } });
});

const INV = { id: 'inv-1', invoice_number: 'INV-D2-777', client_name: 'Acme', project_name: 'P', status: 'draft', total_amount: 100, amount_paid: 0, client_email: 'acme@d2.co.za', items: [] };
describe('customer-invoices detail', () => {
  let gets = 0;
  const reloadAs = (status: string) => (u: string, i?: RequestInit) => {
    if (u.includes('adjacent')) return ok({ prevId: null, nextId: null });
    if (u.includes('customer-invoices-detail') && isGet(i)) return ok({ ...INV, status: ++gets > 1 ? status : 'draft' });
    return undefined;
  };
  const inv = () => { q.current = { invoiceId: 'inv-1' }; gets = 0; return render(<InvoiceDetailPage />); };
  trio3({ name: 'approve invoice', render: inv, drive: async () => { await clickBtn(/^approve$/i); }, match: (u, i) => u.includes('customer-invoices-detail') && i?.method === 'POST',
    data: {}, others: reloadAs('approved'), plain: 'Could not complete that action - try again',
    succeeds: async () => { await vi.waitFor(() => expect(screen.queryByRole('button', { name: /^approve$/i })).toBeNull()); },
    stays: () => { expect(screen.getByRole('button', { name: /^approve$/i })).toBeTruthy(); } });
  trio3({ name: 'email invoice', render: inv, drive: async () => { await clickBtn(/email invoice/i); await clickBtn(/^send/i); },
    match: u => u.includes('invoice-email'), data: { sent: true }, others: reloadAs('draft'), plain: 'Could not send the invoice email - try again',
    succeeds: async () => { expect(await screen.findByText('Invoice emailed successfully!')).toBeTruthy(); },
    stays: () => { expect(screen.queryByText('Invoice emailed successfully!')).toBeNull(); } });
  const portal = async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    await clickBtn(/copy portal link/i);
  };
  const approved = () => { q.current = { invoiceId: 'inv-1' }; return render(<InvoiceDetailPage />); };
  trio3({ name: 'copy portal link', render: approved, drive: portal, match: u => u.includes('portal/invoice/generate'), data: { portalUrl: 'https://p.d2/x' },
    others: (u, i) => (u.includes('customer-invoices-detail') && isGet(i) ? ok({ ...INV, status: 'approved' }) : u.includes('adjacent') ? ok({ prevId: null, nextId: null }) : undefined),
    plain: 'Could not generate the portal link - try again', succeeds: async () => { expect(await screen.findByText('Link Copied!', { exact: false })).toBeTruthy(); } });

  it('adjacent lookup failing leaves the page usable and shows no raw JSON error', async () => {
    vi.mocked(apiFetch).mockReset().mockImplementation(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('adjacent')) return boom();
      return u.includes('customer-invoices-detail') && isGet(init) ? ok(INV) : ok({});
    });
    inv();
    expect((await screen.findAllByText(/INV-D2-777/)).length).toBeGreaterThan(0);
    expectNoRawJsonError();
    expect(screen.queryByText(MSG)).toBeNull();
    await vi.waitFor(() => expect(log.warn).toHaveBeenCalledWith('Adjacent invoices unavailable', expect.anything(), 'customer-invoice-detail'));
  });

  it('a clipboard refusal says so in a plain sentence', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
    vi.mocked(apiFetch).mockReset().mockImplementation(async (url: unknown, init?: RequestInit) => (String(url).includes('customer-invoices-detail') && isGet(init)
      ? ok({ ...INV, status: 'approved', online_payment_enabled: true, payment_url: 'https://pay.d2/x' }) : ok({})));
    inv();
    await clickBtn(/copy payment link/i);
    expect(await screen.findByText('Could not copy the link - copy it manually')).toBeTruthy();
  });

  describe('Pay Now', () => {
    const run = async (err: Error) => {
      vi.mocked(startPayNowCheckout).mockReset().mockRejectedValue(err);
      vi.mocked(apiFetch).mockReset().mockImplementation(async (url: unknown, init?: RequestInit) => (String(url).includes('customer-invoices-detail') && isGet(init) ? ok({ ...INV, status: 'approved' }) : ok({})));
      inv();
      await clickBtn(/^pay now$/i);
    };
    it('a JSON parse failure from the checkout helper becomes a plain sentence', async () => {
      await run(new SyntaxError('Unexpected end of JSON input'));
      expect(await screen.findByText('Could not start the payment - try again')).toBeTruthy();
      expectNoRawJsonError();
    });
    it("the helper's own server message is still shown", async () => {
      await run(new ApiRequestError('D2 server says no: gateway offline', 409));
      expect(await screen.findByText('D2 server says no: gateway offline')).toBeTruthy();
    });
  });
});
