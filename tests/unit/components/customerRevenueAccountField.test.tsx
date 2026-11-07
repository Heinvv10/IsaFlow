/**
 * Master plan wave 4, PR RA: the customer form's "Default revenue account" (migration 966). The kit AccountPicker offers
 * only what the customers route accepts (active leaf revenue accounts that can carry VAT); the edit page shows the stored
 * one and sends it only when changed, and a cleared one goes blank (the route clears it).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok, on, serve } from '../helpers/d2R3a6';

const router = vi.hoisted(() => ({ query: {} as Record<string, string>, isReady: true, pathname: '/', push: vi.fn(async () => true) }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => router }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/utils/toast', () => ({ notify: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

import { apiFetch } from '@/lib/apiFetch';
import EditCustomerPage from '../../../pages/accounting/customers/[customerId]/edit';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); router.push.mockClear(); });
afterEach(() => cleanup());

const CUSTOMER_ID = '44444444-4444-4444-8444-444444444444';
const acct = (id: string, accountCode: string, accountName: string, accountType = 'revenue', parentAccountId: string | null = null) =>
  ({ id, accountCode, accountName, accountType, isActive: true, parentAccountId });
const CHART = [
  acct('a-header', '4000', 'Sales'),
  acct('a-hosting', '4010', 'Hosting', 'revenue', 'a-header'),
  acct('a-consult', '4020', 'Consulting', 'revenue', 'a-header'),
  acct('a-interest', '4310', 'Interest Received'),
  acct('a-rent', '6100', 'Rent', 'expense'),
];
const customer = { id: CUSTOMER_ID, name: 'Herotel', is_active: true, payment_terms: 30, payment_terms_type: 'invoice_days',
  default_discount: '0.00', default_revenue_account_id: 'a-hosting',
  default_revenue_account: { id: 'a-hosting', label: '4010 · Hosting', usable: true, problem: null } };
const stale = { ...customer, default_revenue_account_id: 'a-retired',
  default_revenue_account: { id: 'a-retired', label: '4900 · Retired', usable: false, problem: 'is inactive' } };

const putCalls = () => vi.mocked(apiFetch).mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT');
const putBody = () => JSON.parse(String((putCalls()[0]![1] as RequestInit).body)) as Record<string, unknown>;
const picker = () => screen.getByRole('combobox', { name: 'Default revenue account' });

describe('the customer edit page: default revenue account', () => {
  beforeEach(() => {
    router.query = { customerId: CUSTOMER_ID };
    serve(
      on('GET', `customers?id=${CUSTOMER_ID}`, () => ok(customer)),
      on('GET', 'chart-of-accounts', () => ok(CHART)),
      on('PUT', '/api/accounting/customers', () => ok({ id: CUSTOMER_ID })),
    );
  });

  it('shows the stored account and offers only leaf revenue accounts that can carry VAT', async () => {
    render(<EditCustomerPage />);
    await screen.findByLabelText(/^Customer Name/);
    await waitFor(() => expect(picker().textContent).toContain('4010 · Hosting'));
    fireEvent.click(picker());
    await screen.findByRole('option', { name: '4020 · Consulting' });
    const offered = screen.getAllByRole('option').map((o) => o.textContent);
    expect(offered).toEqual(expect.arrayContaining(['4010 · Hosting', '4020 · Consulting']));
    expect(offered.join('|')).not.toMatch(/4000|Interest|Rent/);
  });

  it('a changed account is sent alone; untouched, it is not sent at all', async () => {
    render(<EditCustomerPage />);
    await waitFor(() => expect(picker().textContent).toContain('4010 · Hosting'));
    fireEvent.click(picker());
    fireEvent.click(await screen.findByRole('option', { name: '4020 · Consulting' }));
    fireEvent.click(screen.getByRole('button', { name: /Save Customer/ }));
    await waitFor(() => expect(putCalls()).toHaveLength(1));
    expect(putBody()).toEqual({ id: CUSTOMER_ID, default_revenue_account_id: 'a-consult' });
  });

  it('a stored account deactivated since shows as "(inactive)" with a warning, saving another field leaves it alone, and it can be cleared', async () => {
    serve(
      on('GET', `customers?id=${CUSTOMER_ID}`, () => ok(stale)),
      on('GET', 'chart-of-accounts', () => ok(CHART)), // the chart route returns active accounts only: 4900 is not in it
      on('PUT', '/api/accounting/customers', () => ok({ id: CUSTOMER_ID })),
    );
    render(<EditCustomerPage />);
    await waitFor(() => expect(picker().textContent).toContain('4900 · Retired (inactive)'));
    expect(screen.getByText(/can no longer be used, so new invoices ignore it/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Credit Limit'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Customer/ }));
    await waitFor(() => expect(putCalls()).toHaveLength(1));
    expect(putBody()).not.toHaveProperty('default_revenue_account_id');
    expect(putBody()).not.toHaveProperty('default_revenue_account_label');
  });

  it('clearing the stored account sends it blank', async () => {
    serve(
      on('GET', `customers?id=${CUSTOMER_ID}`, () => ok(stale)),
      on('GET', 'chart-of-accounts', () => ok(CHART)),
      on('PUT', '/api/accounting/customers', () => ok({ id: CUSTOMER_ID })),
    );
    render(<EditCustomerPage />);
    await waitFor(() => expect(picker().textContent).toContain('4900 · Retired (inactive)'));
    fireEvent.click(screen.getByRole('button', { name: /clear/i }));
    fireEvent.click(screen.getByRole('button', { name: /Save Customer/ }));
    await waitFor(() => expect(putCalls()).toHaveLength(1));
    expect(putBody()).toEqual({ id: CUSTOMER_ID, default_revenue_account_id: '' });
  });
});
