/**
 * #1400 browser pass: the company detail page's Suspend dialog let Suspend be clicked with no reason (the server
 * answers 400). Every Suspend dialog (company detail, list row, list bulk) keeps its button disabled until the reason
 * has non-whitespace text.
 */
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

configure({ asyncUtilTimeout: 4000 });
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { id: 'c-1' }, push: vi.fn(), replace: vi.fn(), pathname: '/', asPath: '/' }) }));
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

import { apiFetch } from '@/lib/apiFetch';
import CompanyDetailPage from '../../../pages/admin/companies/[id]';
import CompaniesPage from '../../../pages/admin/companies/index';
import { useCpuBoundTimeout } from '../../helpers/loadAwareTiming';

useCpuBoundTimeout();

useApiJsonOverMock();
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const COMPANY = { id: 'c-1', name: 'Alpha Ltd', trading_name: null, registration_number: null, vat_number: null, email: null,
  phone: null, website: null, billing_email: null, billing_contact: null, address_line1: null, city: null, province: null,
  postal_code: null, plan_name: 'Starter', billing_cycle: 'monthly', status: 'active', created_at: '2026-01-01T00:00:00Z', last_active: null };
const ROW = { id: 'c-1', name: 'Alpha Ltd', trading_name: null, plan_name: 'Starter', plan_code: 'starter', status: 'active',
  user_count: 1, mrr_cents: 0, created_at: '2026-01-01T00:00:00Z', last_active: null };

beforeEach(() => {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => {
    const p = String(url).split('?')[0]!;
    if (p === '/api/admin/companies/c-1') return ok(COMPANY);
    if (p === '/api/admin/companies') return ok({ items: [ROW], total: 1, page: 1, limit: 25 });
    return ok({});
  });
});
afterEach(cleanup);

const suspendPosts = () => vi.mocked(apiFetch).mock.calls.filter(([u, i]) => String(u).includes('suspend') || (String(u).endsWith('bulk-action') && i?.method === 'POST'));

/** Empty and whitespace keep Suspend disabled; real text enables it. `reason` is the dialog's reason field. */
function expectNeedsReason(dialog: HTMLElement, reason: HTMLElement) {
  const confirm = within(dialog).getByRole('button', { name: 'Suspend' }) as HTMLButtonElement;
  expect(confirm.disabled, 'empty reason').toBe(true);
  fireEvent.change(reason, { target: { value: '   \n ' } });
  expect(confirm.disabled, 'whitespace reason').toBe(true);
  fireEvent.click(confirm);
  expect(suspendPosts()).toHaveLength(0);
  fireEvent.change(reason, { target: { value: 'Unpaid since March' } });
  expect(confirm.disabled, 'typed reason').toBe(false);
}

describe('Suspend needs a reason', () => {
  it('company detail', async () => {
    render(<CompanyDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^suspend$/i }));
    const dialog = await screen.findByRole('dialog');
    expectNeedsReason(dialog, within(dialog).getByLabelText(/reason/i));
  });

  it('company list, row', async () => {
    render(<CompaniesPage />);
    await screen.findByText('Alpha Ltd');
    fireEvent.click(screen.getByTitle('Suspend'));
    const dialog = await screen.findByRole('dialog');
    expectNeedsReason(dialog, within(dialog).getByLabelText(/reason/i));
  });

  it('company list, bulk', async () => {
    render(<CompaniesPage />);
    fireEvent.click(await screen.findByLabelText('Select all'));
    fireEvent.click(await screen.findByRole('button', { name: /bulk suspend/i }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).getByLabelText(/reason/i)).toBeTruthy());
    expectNeedsReason(dialog, within(dialog).getByLabelText(/reason/i));
  });
});
