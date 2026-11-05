/**
 * The supplier and customer edit pages: edit mode prefills the form from the stored record, hides the create-only
 * opening balance, lets the terms be cleared to "Not set", and Save sends PUT with the changes (blank text = clear;
 * never a bank field: the bank details are a read-only masked panel; a category only when the categories were read).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { empty500, ok, on, serve } from '../helpers/d2R3a6';

const router = vi.hoisted(() => ({ query: {} as Record<string, string>, isReady: true, pathname: '/', push: vi.fn(async () => true) }));

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => router }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/utils/toast', () => ({ notify: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

import { apiFetch } from '@/lib/apiFetch';
import EditSupplierPage from '../../../pages/accounting/suppliers/[supplierId]/edit';
import EditCustomerPage from '../../../pages/accounting/customers/[customerId]/edit';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); router.push.mockClear(); });
afterEach(() => cleanup());

const SUPPLIER_ID = '22222222-2222-4222-8222-222222222222';
const CUSTOMER_ID = '44444444-4444-4444-8444-444444444444';
const CATEGORY_ID = '55555555-5555-4555-8555-555555555555';

const supplier = {
  id: SUPPLIER_ID, name: 'Cable Feeder Systems', company_name: 'CFS (Pty) Ltd', email: 'ap@cfs.example', phone: '011 555 0000',
  contact_person: 'Sam', vat_number: '4123456789', registration_number: '2020/1/07', payment_terms: 3,
  payment_terms_type: 'statement_months', address: '1 Main Rd', category: 'Materials', notes: 'Keep sweet',
  is_active: true, subject_to_drc_vat: false, whatsapp_number: '+27820000000', auto_allocate_strategy: 'oldest',
};
const customer = {
  id: CUSTOMER_ID, name: 'Herotel', email: 'ar@herotel.example', phone: '', mobile: '', fax: '', web_address: '',
  contact_person: 'Lee', vat_number: '4999', registration_number: '', payment_terms: 30, payment_terms_type: 'statement_days',
  credit_limit: '50000.00', billing_address: 'PO Box 1', shipping_address: '', notes: '', is_active: true, cash_sale: false,
  accepts_electronic_invoices: true, auto_allocate_strategy: 'off', statement_distribution: 'email',
  default_discount: '5.00', default_vat_type: 'standard', subject_to_drc_vat: false, invoices_viewable_online: true,
  default_price_list: '', category_id: CATEGORY_ID,
};

const putBody = (): Record<string, unknown> => {
  const call = vi.mocked(apiFetch).mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')!;
  return JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>;
};
const putCalls = () => vi.mocked(apiFetch).mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT');

describe('EditSupplierPage', () => {
  beforeEach(() => {
    router.query = { supplierId: SUPPLIER_ID };
    serve(on('GET', `suppliers-list?id=${SUPPLIER_ID}`, () => ok(supplier)), on('PUT', 'suppliers-list', () => ok({ id: SUPPLIER_ID })));
  });

  it('prefills every field from the stored supplier, with the terms as stored and no opening balance', async () => {
    render(<EditSupplierPage />);
    expect(((await screen.findByLabelText(/^Supplier Name/)) as HTMLInputElement).value).toBe('Cable Feeder Systems');
    expect((screen.getByLabelText('Email Address') as HTMLInputElement).value).toBe('ap@cfs.example');
    expect((screen.getByLabelText('Category') as HTMLSelectElement).value).toBe('Materials');
    expect((screen.getByLabelText(/Payment Terms/) as HTMLSelectElement).value).toBe('statement_months');
    expect((screen.getByLabelText('Number of days or months') as HTMLInputElement).value).toBe('3');
    expect(screen.getByText('3 months after statement')).toBeTruthy();
    expect(screen.queryByLabelText('Opening Balance')).toBeNull();
  });

  it('renders no bank inputs: the bank details are the masked read-only panel', async () => {
    serve(
      on('GET', `suppliers-list?id=${SUPPLIER_ID}`, () => ok(supplier)),
      on('GET', 'supplier-bank-verification', () => ok({
        state: 'not_enforced', fingerprint: null, verifierRole: 'admin', canVerify: false, latest: null,
        bank: { bankName: 'FNB', maskedAccount: '…4433', branchCode: '250655', accountType: 'current', holder: null },
      })),
    );
    render(<EditSupplierPage />);
    await screen.findByLabelText(/^Supplier Name/);
    expect(await screen.findByText('…4433')).toBeTruthy();
    for (const label of [/bank name/i, /account number/i, /branch code/i, /account type/i, /account holder/i]) {
      expect(screen.queryByLabelText(label)).toBeNull();
    }
    expect(screen.getByText('Bank details cannot be changed on this page.')).toBeTruthy();
  });

  it('Save sends PUT with the edits: terms cleared to not set, a blank field cleared, no bank field', async () => {
    render(<EditSupplierPage />);
    const email = (await screen.findByLabelText('Email Address')) as HTMLInputElement;
    fireEvent.change(email, { target: { value: '' } });
    fireEvent.change(screen.getByLabelText(/Payment Terms/), { target: { value: 'not_set' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Supplier/ }));
    await waitFor(() => expect(putCalls()).toHaveLength(1));
    const body = putBody();
    expect(body).toMatchObject({ id: SUPPLIER_ID, name: 'Cable Feeder Systems', email: '', payment_terms_type: 'not_set' });
    expect(body).not.toHaveProperty('payment_terms');
    expect(Object.keys(body).filter((k) => /^bank/i.test(k))).toEqual([]);
    expect(body).not.toHaveProperty('opening_balance');
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/accounting/suppliers/${SUPPLIER_ID}`));
  });

  it('changed terms go as the pair', async () => {
    render(<EditSupplierPage />);
    fireEvent.change(await screen.findByLabelText('Number of days or months'), { target: { value: '6' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Supplier/ }));
    await waitFor(() => expect(putCalls()).toHaveLength(1));
    expect(putBody()).toMatchObject({ payment_terms: 6, payment_terms_type: 'statement_months' });
  });

  it('does not save a blank name, and says why', async () => {
    render(<EditSupplierPage />);
    fireEvent.change(await screen.findByLabelText(/^Supplier Name/), { target: { value: ' ' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Supplier/ }));
    expect(await screen.findByText('Supplier name is required')).toBeTruthy();
    expect(putCalls()).toHaveLength(0);
  });

  it('a supplier that does not load shows the error, not an empty form', async () => {
    serve(on('GET', 'suppliers-list', empty500));
    render(<EditSupplierPage />);
    expect(await screen.findByText('Could not load the supplier - try again')).toBeTruthy();
    expect(screen.queryByLabelText(/^Supplier Name/)).toBeNull();
  });
});

describe('EditCustomerPage', () => {
  const categories = [{ id: CATEGORY_ID, name: 'Wholesale' }, { id: 'other', name: 'Retail' }];
  beforeEach(() => {
    router.query = { customerId: CUSTOMER_ID };
    serve(
      on('GET', `customers?id=${CUSTOMER_ID}`, () => ok(customer)),
      on('GET', 'customer-categories', () => ok(categories)),
      on('PUT', '/api/accounting/customers', () => ok({ id: CUSTOMER_ID })),
    );
  });

  it('prefills from the stored customer: terms, category, discount; no opening balance', async () => {
    render(<EditCustomerPage />);
    expect(((await screen.findByLabelText(/^Customer Name/)) as HTMLInputElement).value).toBe('Herotel');
    await waitFor(() => expect((screen.getByLabelText('Category') as HTMLSelectElement).value).toBe(CATEGORY_ID));
    expect((screen.getByLabelText(/Payment Terms/) as HTMLSelectElement).value).toBe('statement_days');
    expect((screen.getByLabelText('Default Discount %') as HTMLInputElement).value).toBe('5.00');
    expect((screen.getByLabelText('Credit Limit') as HTMLInputElement).value).toBe('50000.00');
    expect(screen.queryByLabelText('Opening Balance')).toBeNull();
  });

  it('Save sends PUT: a cleared credit limit goes blank, terms cleared to not set, the category kept', async () => {
    render(<EditCustomerPage />);
    fireEvent.change(await screen.findByLabelText('Credit Limit'), { target: { value: '' } });
    await waitFor(() => expect((screen.getByLabelText('Category') as HTMLSelectElement).value).toBe(CATEGORY_ID));
    fireEvent.change(screen.getByLabelText(/Payment Terms/), { target: { value: 'not_set' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Customer/ }));
    await waitFor(() => expect(putCalls()).toHaveLength(1));
    expect(putBody()).toMatchObject({ id: CUSTOMER_ID, credit_limit: '', payment_terms_type: 'not_set', category_id: CATEGORY_ID, default_discount: '5.00' });
    expect(putBody()).not.toHaveProperty('payment_terms');
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/accounting/customers/${CUSTOMER_ID}`));
  });

  it('when the categories could not be read the stored category is left out, never cleared', async () => {
    serve(
      on('GET', `customers?id=${CUSTOMER_ID}`, () => ok(customer)),
      on('GET', 'customer-categories', empty500),
      on('PUT', '/api/accounting/customers', () => ok({ id: CUSTOMER_ID })),
    );
    render(<EditCustomerPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Save Customer/ }));
    await waitFor(() => expect(putCalls()).toHaveLength(1));
    expect(putBody()).not.toHaveProperty('category_id');
  });
});
