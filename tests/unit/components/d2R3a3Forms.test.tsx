/**
 * D2 round 3 (a3): customer-invoice create/edit, customer-payment create + detail actions, manual bank
 * transaction. A 400 shows the server's message and the form stays (no redirect / no success), an empty-body
 * 500 a plain sentence (never a JSON parse error), a 200 redirects / confirms.
 */
import { cleanup, configure, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

const push = vi.fn();
const q: { current: Record<string, string> } = { current: {} };
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: q.current, push, replace: vi.fn(), pathname: '/', isReady: true }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/modules/accounting/documents', () => ({ AccountingDocumentPanel: () => null }));
vi.mock('@/components/accounting/ScanAndFillButton', () => ({ ScanAndFillButton: () => null }));
vi.mock('@/components/accounting/lateClaimNotice', () => ({ notifyLateClaims: vi.fn() }));
vi.mock('@/utils/toast', () => {
  const show = (m: string) => { const d = document.createElement('div'); d.setAttribute('data-toast', ''); d.textContent = m; document.body.appendChild(d); };
  return { notify: { error: show, success: show, info: show, warning: show } };
});

import NewInvoicePage from '../../../pages/accounting/customer-invoices/new';
import EditInvoicePage from '../../../pages/accounting/customer-invoices/edit/[invoiceId]';
import NewPaymentPage from '../../../pages/accounting/customer-payments/new';
import PaymentDetailPage from '../../../pages/accounting/customer-payments/[paymentId]';
import NewBankTxPage from '../../../pages/accounting/bank-transactions/new';
import { ok } from '../helpers/d2CensusG4';
import { trio3 } from '../helpers/d2R3a3';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
afterEach(() => { cleanup(); push.mockClear(); document.querySelectorAll('[data-toast]').forEach(n => n.remove()); vi.unstubAllGlobals(); });

const isGet = (init?: RequestInit) => !init?.method || init.method === 'GET';
const clickBtn = async (name: RegExp) => fireEvent.click(await screen.findByRole('button', { name }));
const submitForm = () => fireEvent.submit(document.querySelector('form')!);
const toastText = () => Array.from(document.querySelectorAll('[data-toast]')).map(n => n.textContent).join('|');
const CLIENTS = [{ id: 'c-1', name: 'D2 Client' }];

describe('customer-invoices/new submit', () => {
  const drive = async () => {
    await screen.findByRole('option', { name: 'D2 Client' });
    fireEvent.change(document.querySelector('select[name="clientId"]')!, { target: { value: 'c-1' } });
    fireEvent.change(screen.getByPlaceholderText('Item description'), { target: { value: 'D2 work' } });
    fireEvent.change(document.querySelector('input[name="unitPrice"]')!, { target: { value: '50' } });
    await clickBtn(/^create invoice$/i);
  };
  trio3({ name: 'create invoice', render: () => render(<NewInvoicePage />), drive, match: (u, i) => u.includes('customer-invoices-create') && i?.method === 'POST',
    data: { id: 'new-inv' }, others: u => (u.endsWith('/customers') ? ok(CLIENTS) : u.includes('currencies') ? ok([]) : undefined),
    plain: 'Could not create the invoice - try again',
    succeeds: async () => { await vi.waitFor(() => expect(push).toHaveBeenCalledWith('/accounting/customer-invoices/new-inv')); },
    stays: () => { expect(push).not.toHaveBeenCalled(); expect(screen.getByRole('button', { name: /^create invoice$/i })).toBeTruthy(); } });
});

const EDIT_INV = { id: 'inv-1', invoice_number: 'INV-D2-EDIT', status: 'draft', client_id: 'c-1', invoice_date: '2031-03-01', tax_rate: 15, currency_code: 'ZAR', exchange_rate: 1,
  items: [{ description: 'D2 line', quantity: 1, unit_price: 10, amount: 10 }] };
describe('customer-invoices/edit submit', () => {
  trio3({ name: 'save invoice', render: () => { q.current = { invoiceId: 'inv-1' }; return render(<EditInvoicePage />); },
    drive: async () => { await screen.findByDisplayValue('D2 line'); await clickBtn(/save changes/i); },
    match: (u, i) => u.includes('customer-invoices-detail') && i?.method === 'PUT', data: {},
    others: (u, i) => (u.endsWith('/customers') ? ok(CLIENTS) : u.includes('currencies') ? ok([]) : u.includes('customer-invoices-detail') && isGet(i) ? ok(EDIT_INV) : undefined),
    plain: 'Could not save the invoice - try again',
    succeeds: async () => { await vi.waitFor(() => expect(push).toHaveBeenCalledWith('/accounting/customer-invoices/inv-1')); },
    stays: () => { expect(push).not.toHaveBeenCalled(); expect(screen.getByRole('button', { name: /save changes/i })).toBeTruthy(); } });
});

describe('customer-payments/new submit', () => {
  trio3({ name: 'record payment', render: () => { q.current = { clientId: 'c-1', invoiceId: 'inv-1', amount: '100' }; return render(<NewPaymentPage />); },
    drive: async () => { await screen.findByRole('button', { name: /create payment/i }); submitForm(); },
    match: (u, i) => u.endsWith('/customer-payments') && i?.method === 'POST', data: { id: 'p1' },
    others: u => (u.endsWith('/customers') ? ok(CLIENTS) : u.includes('customer-invoices-list') ? ok([]) : undefined), plain: 'Could not record the payment - try again',
    succeeds: async () => { await vi.waitFor(() => expect(push).toHaveBeenCalledWith('/accounting/customer-payments')); },
    stays: () => { expect(push).not.toHaveBeenCalled(); } });
});

const PAY = { id: 'p-1', paymentNumber: 'PAY-D2-1', clientId: 'c-1', clientName: 'D2 Client', paymentDate: '2031-03-01', totalAmount: 100, paymentMethod: 'eft', status: 'draft', allocations: [] };
describe('customer-payments detail actions', () => {
  let gets = 0;
  const others = (u: string, i?: RequestInit) => (u.includes('customer-payments?id=') && isGet(i) ? ok({ ...PAY, status: ++gets > 1 ? 'confirmed' : 'draft' }) : undefined);
  trio3({ name: 'confirm payment', setup: () => { gets = 0; }, render: () => { q.current = { paymentId: 'p-1' }; return render(<PaymentDetailPage />); },
    drive: async () => { await clickBtn(/confirm & post gl/i); }, match: (u, i) => u.includes('customer-payments-action') && i?.method === 'POST', data: {}, others,
    plain: 'Could not confirm the payment - try again',
    succeeds: async () => { expect(await screen.findByText('confirmed')).toBeTruthy(); expect(toastText()).toContain('Payment confirmed and GL posted'); },
    stays: () => { expect(toastText()).not.toContain('Payment confirmed'); expect(screen.getByRole('button', { name: /confirm & post gl/i })).toBeTruthy(); } });
  trio3({ name: 'cancel payment', render: () => { q.current = { paymentId: 'p-1' }; vi.stubGlobal('prompt', () => 'D2 reason'); return render(<PaymentDetailPage />); },
    drive: async () => { await clickBtn(/cancel payment/i); }, match: (u, i) => u.includes('customer-payments-action') && i?.method === 'POST', data: {},
    others: (u, i) => (u.includes('customer-payments?id=') && isGet(i) ? ok({ ...PAY, status: 'confirmed' }) : undefined), plain: 'Could not cancel the payment - try again',
    succeeds: async () => { await vi.waitFor(() => expect(toastText()).toContain('Payment cancelled')); },
    stays: () => { expect(toastText()).not.toContain('Payment cancelled'); } });
});

describe('bank-transactions/new submit', () => {
  const drive = async () => {
    fireEvent.change(await screen.findByPlaceholderText('Search accounts…'), { target: { value: 'D2 GL' } });
    fireEvent.click(await screen.findByRole('button', { name: /D2 GL Expense/ }));
    fireEvent.change(document.querySelector('input[name="amount"]')!, { target: { value: '25' } });
    await vi.waitFor(() => expect((document.querySelector('select[name="bankAccountId"]') as HTMLSelectElement).value).toBe('b-1'));
    submitForm();
  };
  trio3({ name: 'record transaction', render: () => { q.current = {}; return render(<NewBankTxPage />); }, drive,
    match: (u, i) => u.includes('bank-transactions-manual') && i?.method === 'POST', data: {},
    others: u => (u.includes('/bank-accounts') ? ok([{ id: 'b-1', accountCode: '1000', accountName: 'D2 Bank' }])
      : u.includes('chart-of-accounts') ? ok([{ id: 'g-1', accountCode: '5000', accountName: 'D2 GL Expense', accountSubtype: 'expense' }]) : undefined),
    plain: 'Could not record the transaction - try again',
    succeeds: async () => { await vi.waitFor(() => expect(push).toHaveBeenCalledWith('/accounting/bank-transactions')); expect(toastText()).toContain('Transaction recorded successfully'); },
    stays: () => { expect(push).not.toHaveBeenCalled(); expect(toastText()).not.toContain('recorded successfully'); } });
});
