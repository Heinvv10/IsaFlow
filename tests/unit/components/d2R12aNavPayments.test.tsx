/**
 * D2 round 12: the money forms that open the new record after the write succeeded (supplier payment, bank
 * transaction, batch payment, supplier). A pending navigation keeps the button disabled; a cancelled one releases it;
 * a rejected one is logged and never says the write failed (a retry would pay or create a second time).
 */
import { afterEach, beforeEach, describe, it, vi, expect } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok, on, serve } from '../helpers/d2R3a6';
import { pendingNavigationKeepsButtonDisabled, rejectedNavigationIsNotAWriteFailure, type NavCase } from '../helpers/d2R12aNav';

const route = vi.hoisted(() => ({ query: {} as Record<string, string>, push: vi.fn(), replace: vi.fn(), isReady: true, pathname: '/' }));
const warn = vi.hoisted(() => vi.fn());
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn, debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => route }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner', companyId: 'c1', activeCompany: { id: 'c1' } }) }));
vi.mock('@/modules/accounting/documents', () => ({ AccountingDocumentPanel: () => null }));
vi.mock('@/components/accounting/ScanAndFillButton', () => ({ ScanAndFillButton: () => null }));
vi.mock('@/components/accounting/lateClaimNotice', () => ({ notifyLateClaims: vi.fn() }));
vi.mock('@/components/accounting/supplier-invoices/matchVendorSupplier', () => ({ useVendorSupplierMatch: () => ({ scan: vi.fn(), notePick: vi.fn() }) }));
vi.mock('@/components/accounting/supplier-invoices/SupplierSelect', () => ({
  SupplierSelect: ({ onChange }: { onChange: (id: string, name: string) => void }) => <button type="button" onClick={() => onChange('sup-1', 'D2 Supplier')}>pick supplier</button>,
}));
vi.mock('@/utils/toast', () => {
  const show = (m: string) => { const d = document.createElement('div'); d.setAttribute('data-toast', ''); d.textContent = m; document.body.appendChild(d); };
  return { notify: { error: show, success: show, info: show, warning: show } };
});

import { apiFetch } from '@/lib/apiFetch';
import SupplierPaymentNewPage from '../../../pages/accounting/supplier-payments/new';
import BankTxNewPage from '../../../pages/accounting/bank-transactions/new';
import BatchNewPage from '../../../pages/accounting/batch-payments/new';
import SupplierNewPage from '../../../pages/accounting/suppliers/new';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); route.push.mockReset(); warn.mockReset(); });
afterEach(() => { cleanup(); document.querySelectorAll('[data-toast]').forEach((n) => n.remove()); });

const toasts = () => Array.from(document.querySelectorAll('[data-toast]')).map((n) => n.textContent).join('|');
const form = () => document.querySelector('form') as HTMLFormElement;
const submitBtn = () => document.querySelector('button[type="submit"]') as HTMLButtonElement;

describe('supplier-payments/new', () => {
  const nav = (): NavCase => ({
    push: route.push, warn, button: submitBtn,
    drive: async () => {
      serve(on('POST', '/api/accounting/supplier-payments', () => ok({ id: 'p9' })),
        on('GET', 'supplier-invoices', () => ok({ invoices: [{ id: 'i1', invoiceNumber: 'INV-D2-1', totalAmount: 100, balance: 100 }] })));
      render(<SupplierPaymentNewPage />);
      fireEvent.click(screen.getByRole('button', { name: 'pick supplier' }));
      await screen.findAllByText(/INV-D2-1/);
      fireEvent.change(document.querySelector('select[name="invoiceId"]')!, { target: { value: 'i1' } });
      const amount = document.querySelector('input[type="number"][max]') as HTMLInputElement;
      fireEvent.change(amount, { target: { value: '100' } });
      fireEvent.submit(form());
    },
    claimsFailure: () => screen.queryByText(/Could not create the payment/) !== null,
  });
  it('a pending navigation keeps the button disabled; a cancelled one releases it', async () => { await pendingNavigationKeepsButtonDisabled(nav()); });
  it('a rejected navigation does not say the payment failed', async () => { await rejectedNavigationIsNotAWriteFailure(nav()); });
});

describe('bank-transactions/new', () => {
  const nav = (): NavCase => ({
    push: route.push, warn, button: () => screen.getByRole('button', { name: /Record Transaction|Recording/ }),
    drive: async () => {
      serve(on('POST', 'bank-transactions-manual', () => ok({})),
        on('GET', '/bank-accounts', () => ok([{ id: 'b-1', accountCode: '1000', accountName: 'D2 Bank' }])),
        on('GET', 'chart-of-accounts', () => ok([{ id: 'g-1', accountCode: '5000', accountName: 'D2 GL Expense', accountSubtype: 'expense' }])));
      render(<BankTxNewPage />);
      fireEvent.change(await screen.findByPlaceholderText('Search accounts…'), { target: { value: 'D2 GL' } });
      fireEvent.click(await screen.findByRole('button', { name: /D2 GL Expense/ }));
      fireEvent.change(document.querySelector('input[name="amount"]')!, { target: { value: '25' } });
      await waitFor(() => expect((document.querySelector('select[name="bankAccountId"]') as HTMLSelectElement).value).toBe('b-1'));
      fireEvent.submit(form());
    },
    claimsFailure: () => /Could not record the transaction/.test(toasts()),
  });
  it('a pending navigation keeps the button disabled; a cancelled one releases it', async () => { await pendingNavigationKeepsButtonDisabled(nav()); });
  it('a rejected navigation does not say the transaction failed', async () => { await rejectedNavigationIsNotAWriteFailure(nav()); });
});

describe('batch-payments/new', () => {
  const nav = (): NavCase => ({
    push: route.push, warn, button: submitBtn,
    drive: async () => {
      serve(on('POST', '/api/accounting/batch-payments', () => ok({ id: 'bt1' })),
        on('GET', 'supplier-invoices', () => ok({ invoices: [{ id: 'b1', invoiceNumber: 'D2-INV-9', supplierId: 'sup-1', totalAmount: 500, amountPaid: 100 }], total: 1 })),
        on('GET', 'reservedFor', () => ok({})));
      render(<BatchNewPage />);
      await screen.findByText(/D2-INV-9/);
      fireEvent.click(screen.getByText('pick supplier'));
      const sel = Array.from(document.querySelectorAll('select')).find((s) => s.getAttribute('name') === 'invoiceId') as HTMLSelectElement;
      fireEvent.change(sel, { target: { value: 'b1' } });
      fireEvent.submit(form());
    },
    claimsFailure: () => screen.queryByText(/Could not create the batch/) !== null,
  });
  it('a pending navigation keeps the button disabled; a cancelled one releases it', async () => { await pendingNavigationKeepsButtonDisabled(nav()); });
  it('a rejected navigation does not say the batch failed', async () => { await rejectedNavigationIsNotAWriteFailure(nav()); });
});

describe('suppliers/new', () => {
  const nav = (): NavCase => ({
    push: route.push, warn, button: submitBtn,
    drive: () => {
      serve(on('POST', 'suppliers-list', () => ok({ id: 's-1' })));
      render(<SupplierNewPage />);
      fireEvent.change(screen.getByPlaceholderText(/ABC Supplies/), { target: { value: 'D2 Supplier' } });
      fireEvent.click(screen.getByRole('button', { name: /Save Supplier/ }));
    },
    claimsFailure: () => /Could not create the supplier/.test(toasts()),
  });
  it('a pending navigation keeps the button disabled; a cancelled one is released, not stuck on Saving', async () => { await pendingNavigationKeepsButtonDisabled(nav()); });
  it('a rejected navigation does not say the supplier failed', async () => { await rejectedNavigationIsNotAWriteFailure(nav()); });
});
