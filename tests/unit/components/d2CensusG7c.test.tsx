/**
 * d2 census group 7 (c): user-triggered actions and form reference loads that read `res.json()` without a
 * `res.ok` check. 400 envelope, empty 500 and 200, through the real apiFetch helpers.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { MSG, respond, serveRoutes, type Kind } from '../helpers/d2CensusG7Serve';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
const company = vi.hoisted(() => ({ activeCompany: { id: 'co-1' } })); // stable: a fresh object per render refetches forever
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => company }));
vi.mock('@/components/accounting/statements/CustomerStatementTable', () => ({ CustomerStatementTable: () => null }));
vi.mock('@/components/accounting/statements/ConfirmSendModal', () => ({
  ConfirmSendModal: ({ onConfirm }: { onConfirm: () => void }) => <button onClick={onConfirm}>D2 confirm send</button>,
}));
vi.mock('@/lib/fetchAllSuppliers', async (orig) => ({ ...await orig<typeof import('@/lib/fetchAllSuppliers')>(),
  fetchAllSuppliers: async () => ({ suppliers: [], truncated: false }) }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }));
vi.mock('@/utils/toast', () => ({ notify: toast, default: toast }));
const route = vi.hoisted(() => ({ query: {} as Record<string, string>, push: vi.fn(), isReady: true }));
vi.mock('next/router', () => ({ useRouter: () => route }));

import DocumentCaptureDetailPage from '../../../pages/accounting/document-capture/[docId]';
import StatementsPage from '../../../pages/accounting/statements/index';
import CustomerQuotesPage from '../../../pages/accounting/customer-quotes/index';
import RecurringTransactionsPage from '../../../pages/accounting/recurring-transactions';
import NewBankTransactionPage from '../../../pages/accounting/bank-transactions/new';

useApiJsonOverMock();
beforeEach(() => { route.query = {}; });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const noRaw = (s: string) => { expect(s).not.toMatch(/JSON|Unexpected end/); };

describe('document capture detail: reject and match', () => {
  const doc = { id: 'doc1', fileName: 'd2-invoice.pdf', status: 'pending', createdAt: '2026-01-01', fileSize: 0, extractedData: null,
    vendorName: null, documentDate: null, referenceNumber: null, totalAmount: null, vatAmount: null, documentType: null, notes: null, matchedBankTxId: null };
  const open = async (kind: Kind) => {
    route.query = { docId: 'doc1' };
    serveRoutes([['document-capture-action', () => respond(kind)], ['/api/accounting/document-capture?', () => respond('ok', doc)]]);
    render(<DocumentCaptureDetailPage />);
    await screen.findByText('d2-invoice.pdf');
  };
  const reject = async (kind: Kind) => { await open(kind); fireEvent.click(screen.getByRole('button', { name: /reject/i })); };
  const match = async (kind: Kind) => {
    await open(kind);
    fireEvent.change(screen.getByPlaceholderText(/bank transaction id/i), { target: { value: 'btx-1' } });
    fireEvent.click(screen.getByRole('button', { name: /^match$/i }));
  };
  it('reject: toasts the server message on a 400', async () => { await reject('bad'); await waitFor(() => expect(toast.error).toHaveBeenCalledWith(MSG)); });
  it('reject: toasts a plain sentence on an empty 500', async () => {
    await reject('empty500'); await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(String(toast.error.mock.calls[0]![0])).toMatch(/could not reject the document/i); noRaw(String(toast.error.mock.calls[0]![0]));
  });
  it('reject: confirms on a 200', async () => { await reject('ok'); await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Document rejected')); });
  it('match: toasts the server message on a 400', async () => { await match('bad'); await waitFor(() => expect(toast.error).toHaveBeenCalledWith(MSG)); });
  it('match: toasts a plain sentence on an empty 500', async () => {
    await match('empty500'); await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(String(toast.error.mock.calls[0]![0])).toMatch(/could not match the document/i); noRaw(String(toast.error.mock.calls[0]![0]));
  });
  it('match: confirms on a 200', async () => { await match('ok'); await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Matched to bank transaction')); });
});

describe('statements: send', () => {
  const send = async (kind: Kind) => {
    serveRoutes([
      ['customer-statements-send', () => respond(kind, { sent: 1, failed: 0, errors: [] })],
      ['customer-statements', () => respond('ok', { customers: [{ client_id: 'k1', client_name: 'D2 Customer', total_invoiced: 100, total_paid: 0, balance: 100, invoice_count: 1 }] })],
      ['/api/accounting/customers', () => respond('ok', [{ id: 'k1', email: 'd2@example.test' }])],
    ]);
    render(<StatementsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /send to 1 customer/i }));
    fireEvent.click(await screen.findByText('D2 confirm send'));
  };
  it('shows the server message on a 400', async () => { await send('bad'); expect(await screen.findByText(new RegExp(MSG))).toBeTruthy(); });
  it('shows a plain sentence on an empty 500', async () => {
    await send('empty500'); expect(await screen.findByText(/could not send the statements/i)).toBeTruthy(); expect(document.body.textContent).not.toMatch(/JSON|Unexpected end/);
  });
  it('reports the result on a 200', async () => { await send('ok'); expect(await screen.findByText(/1 sent successfully/)).toBeTruthy(); });
});

describe('customer quotes: convert to sales order', () => {
  const quote = { id: 'q1', quoteNumber: 'QT-D2-31', customerName: 'D2 Customer', quoteDate: '2026-01-01', expiryDate: null, status: 'accepted', total: 10 };
  const convert = async (kind: Kind) => {
    window.confirm = vi.fn(() => true);
    const alert = vi.fn(); window.alert = alert;
    serveRoutes([
      ['customer-quotes-action', () => respond(kind, { salesOrderId: 'so-D2-1' })],
      ['/api/accounting/customer-quotes?', () => respond('ok', { quotes: [quote], total: 1 })],
    ]);
    render(<CustomerQuotesPage />);
    fireEvent.click(await screen.findByRole('button', { name: /to so/i }));
    return alert;
  };
  it('alerts the server message on a 400', async () => { const a = await convert('bad'); await waitFor(() => expect(a).toHaveBeenCalledWith(MSG)); });
  it('alerts a plain sentence on an empty 500', async () => {
    const a = await convert('empty500'); await waitFor(() => expect(a).toHaveBeenCalled());
    expect(String(a.mock.calls[0]![0])).toMatch(/could not convert the quote/i); noRaw(String(a.mock.calls[0]![0]));
  });
  it('opens the sales order on a 200', async () => {
    await convert('ok'); await waitFor(() => expect(route.push).toHaveBeenCalledWith('/accounting/customer-sales-orders/so-D2-1'));
  });
});

describe('recurring transactions: run now', () => {
  const template = { id: 't1', name: 'D2 Rent Template', entityType: 'journal_entry', frequency: 'monthly', nextRunDate: null,
    lastRunDate: null, isActive: true, autoPost: false, templateData: {} };
  const run = async (kind: Kind) => {
    serveRoutes([
      ['recurring-transactions-execute', () => respond(kind, { entityType: 'journal_entry', entityId: 'D2-JE-1', posted: true })],
      ['/api/accounting/recurring-transactions', () => respond('ok', [template])],
    ]);
    render(<RecurringTransactionsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /run now/i }));
  };
  it('shows the server message on a 400', async () => { await run('bad'); expect(await screen.findByText(new RegExp(MSG))).toBeTruthy(); });
  it('shows a plain sentence on an empty 500', async () => {
    await run('empty500'); expect(await screen.findByText(/could not run the template/i)).toBeTruthy(); expect(document.body.textContent).not.toMatch(/JSON|Unexpected end/);
  });
  it('marks the run created on a 200', async () => { await run('ok'); expect(await screen.findByText(/Created/)).toBeTruthy(); });
});

describe('new bank transaction: reference lists', () => {
  const gl = { id: 'g1', accountCode: 'D2-4000', accountName: 'D2 Ledger Account', accountSubtype: 'expense' };
  const customer = { id: 'cu1', company_name: 'D2 Customer Ltd' };
  const open = (accounts: Kind, customers: Kind) => {
    serveRoutes([
      ['bank-accounts', () => respond('ok', [{ id: 'b1', accountCode: '1000', accountName: 'Cheque' }])],
      ['chart-of-accounts', () => respond(accounts, [gl])],
      ['/api/accounting/customers', () => respond(customers, [customer])],
    ]);
    render(<NewBankTransactionPage />);
  };
  const search = async (tab: string | null, text: string) => {
    if (tab) fireEvent.click(await screen.findByRole('button', { name: tab }, { timeout: 3000 }));
    fireEvent.change(await screen.findByPlaceholderText(/^Search (account|customer)s…$/, {}, { timeout: 3000 }), { target: { value: text } });
  };
  it('accounts: toasts the server message on a 400', async () => { open('bad', 'ok'); await waitFor(() => expect(toast.error).toHaveBeenCalledWith(MSG)); });
  it('accounts: toasts a plain sentence on an empty 500', async () => {
    open('empty500', 'ok'); await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not load accounts - try again'));
  });
  it('accounts: lists the account on a 200', async () => { open('ok', 'ok'); await search(null, 'D2'); expect(await screen.findByText('D2 Ledger Account')).toBeTruthy(); });
  it('customers: toasts the server message on a 400', async () => { open('ok', 'bad'); await waitFor(() => expect(toast.error).toHaveBeenCalledWith(MSG)); });
  it('customers: toasts a plain sentence on an empty 500', async () => {
    open('ok', 'empty500'); await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not load customers - try again'));
  });
  it('customers: lists the customer on a 200', async () => { open('ok', 'ok'); await search('Customer', 'D2'); expect(await screen.findByText('D2 Customer Ltd')).toBeTruthy(); });
});

