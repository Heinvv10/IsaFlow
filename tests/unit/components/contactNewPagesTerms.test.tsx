/**
 * The create pages refuse to save until the payment terms are chosen (no pre-selection), and accept "Use company default".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
import NewSupplierPage from '../../../pages/accounting/suppliers/new';
import NewCustomerPage from '../../../pages/accounting/customers/new';

useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); router.push.mockClear(); });
afterEach(() => cleanup());

const posts = () => vi.mocked(apiFetch).mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
const body = () => JSON.parse(String((posts()[0]![1] as RequestInit).body)) as Record<string, unknown>;

describe.each([
  ['supplier', NewSupplierPage, /ABC Supplies/, /Save Supplier/, 'suppliers-list'],
  ['customer', NewCustomerPage, /Acme Corporation/, /Save Customer/, '/api/accounting/customers'],
] as const)('new %s page', (_who, Page, namePlaceholder, saveName, route) => {
  const open = () => {
    serve(on('POST', route, () => ok({ id: 'x-1' })));
    render(<Page />);
    fireEvent.change(screen.getByPlaceholderText(namePlaceholder), { target: { value: 'Acme' } });
  };

  it('refuses to save with the terms unchosen, says why, and sends nothing', async () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: saveName }));
    expect(await screen.findByText('Choose the payment terms')).toBeTruthy();
    expect(posts()).toHaveLength(0);
  });

  it('saves once Immediate is chosen: 0 invoice days', async () => {
    open();
    fireEvent.change(screen.getByLabelText(/payment terms/i), { target: { value: 'immediate' } });
    fireEvent.click(screen.getByRole('button', { name: saveName }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(body()).toMatchObject({ payment_terms: 0, payment_terms_type: 'invoice_days' });
  });

  it('saves "Use company default" as not_set with no number', async () => {
    open();
    fireEvent.change(screen.getByLabelText(/payment terms/i), { target: { value: 'default' } });
    fireEvent.click(screen.getByRole('button', { name: saveName }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(body().payment_terms_type).toBe('not_set');
    expect(body().payment_terms === '' || body().payment_terms === undefined).toBe(true);
  });
});
