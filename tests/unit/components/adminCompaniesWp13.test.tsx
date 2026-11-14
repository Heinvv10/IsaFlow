// Admin Companies list (WP13, admin audit 2026-11-14):
//  - a row checkbox ticks on one click (the cell's onClick used to toggle it straight back);
//  - Suspend (row and bulk) asks first and sends the reason the admin typed, never a hard-coded one (3.7);
//  - a bulk action's errors[] are shown, not dropped (3.7), as an alert, naming companies not on the page by id;
//  - a failed suspend keeps the dialog open with the typed reason and says why;
//  - Add Company is a real dialog: aria-modal, labelled inputs, Escape closes (4.13).
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

configure({ asyncUtilTimeout: 4000 });
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn(), replace: vi.fn(), pathname: '/', asPath: '/' }) }));
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/hooks/useAdminPrefix', () => ({ useAdminHref: () => (p: string) => p }));

import { apiFetch } from '@/lib/apiFetch';
import CompaniesPage from '../../../pages/admin/companies/index';

useApiJsonOverMock();
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const row = (id: string, name: string) => ({ id, name, trading_name: null, plan_name: 'Starter', plan_code: 'starter', status: 'active',
  user_count: 1, mrr_cents: 0, created_at: '2026-01-01T00:00:00Z', last_active: null });
const ROWS = [row('c-1', 'Alpha Ltd'), row('c-2', 'Beta Ltd')];

function serve(bulk: { processed: number; errors: string[] } = { processed: 2, errors: [] }, suspendFails = false) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => {
    const p = String(url).split('?')[0]!;
    if (suspendFails && p.endsWith('/suspend')) {
      return new Response(JSON.stringify({ success: false, error: { message: 'Company is locked by an import' } }), { status: 409 });
    }
    if (p === '/api/admin/companies') return ok({ items: ROWS, total: 2, page: 1, limit: 25 });
    if (p === '/api/admin/companies/bulk-action') return ok(bulk);
    return ok({});
  });
}
const posts = (path: string) => vi.mocked(apiFetch).mock.calls
  .filter(([u, i]) => String(u) === path && i?.method === 'POST')
  .map(([, i]) => JSON.parse(String(i?.body ?? '{}')) as Record<string, unknown>);

beforeEach(() => { serve(); });
afterEach(() => { cleanup(); });

describe('row selection', () => {
  it('one click on a row checkbox selects that company', async () => {
    render(<CompaniesPage />);
    fireEvent.click(await screen.findByLabelText('Select Alpha Ltd'));
    expect(await screen.findByText('1 company selected')).toBeTruthy();
    expect((screen.getByLabelText('Select Alpha Ltd') as HTMLInputElement).checked).toBe(true);
  });
});

describe('Suspend asks first and sends the typed reason', () => {
  it('row Suspend: nothing is posted until a reason is typed and confirmed', async () => {
    render(<CompaniesPage />);
    await screen.findByText('Alpha Ltd');
    fireEvent.click(screen.getAllByTitle('Suspend')[0]!);
    const dialog = await screen.findByRole('dialog');
    expect(posts('/api/admin/companies/c-1/suspend')).toHaveLength(0);
    const confirm = within(dialog).getByRole('button', { name: 'Suspend' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(/reason/i), { target: { value: 'Unpaid since March' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(posts('/api/admin/companies/c-1/suspend')).toEqual([{ reason: 'Unpaid since March' }]));
  });

  it('bulk Suspend confirms, sends the reason and shows the errors the API returned', async () => {
    serve({ processed: 1, errors: ['c-2: not found or deleted', '0000dead-0000-4000-8000-000000000000: not found or deleted'] });
    render(<CompaniesPage />);
    fireEvent.click(await screen.findByLabelText('Select all'));
    fireEvent.click(await screen.findByRole('button', { name: /bulk suspend/i }));
    const dialog = await screen.findByRole('dialog');
    expect(posts('/api/admin/companies/bulk-action')).toHaveLength(0);
    fireEvent.change(within(dialog).getByLabelText(/reason/i), { target: { value: 'Fraud review' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Suspend' }));
    await waitFor(() => expect(posts('/api/admin/companies/bulk-action')).toEqual([
      { action: 'suspend', company_ids: ['c-1', 'c-2'], reason: 'Fraud review' },
    ]));
    const notice = await screen.findByRole('alert');
    expect(notice.textContent).toContain('1 done, 2 failed');
    expect(notice.textContent).toContain('Beta Ltd: not found or deleted');
    expect(notice.textContent).toContain('company 0000dead: not found or deleted');
  });
});

describe('a failed suspend', () => {
  it('keeps the dialog open with the reason and shows why', async () => {
    serve(undefined, true);
    render(<CompaniesPage />);
    await screen.findByText('Alpha Ltd');
    fireEvent.click(screen.getAllByTitle('Suspend')[0]!);
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/reason/i), { target: { value: 'Unpaid since March' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Suspend' }));
    expect(await within(dialog).findByText('Company is locked by an import')).toBeTruthy();
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect((within(dialog).getByLabelText(/reason/i) as HTMLTextAreaElement).value).toBe('Unpaid since March');
  });
});

describe('Add Company dialog', () => {
  it('is modal, labels its inputs and closes on Escape', async () => {
    render(<CompaniesPage />);
    fireEvent.click(await screen.findByRole('button', { name: /add company/i }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(within(dialog).getByLabelText(/company name/i).tagName).toBe('INPUT');
    expect(within(dialog).getByLabelText(/^phone/i).tagName).toBe('INPUT');
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('opens empty again after Cancel', async () => {
    render(<CompaniesPage />);
    fireEvent.click(await screen.findByRole('button', { name: /add company/i }));
    fireEvent.change(within(await screen.findByRole('dialog')).getByLabelText(/company name/i), { target: { value: 'Half typed' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: /add company/i }));
    expect((within(await screen.findByRole('dialog')).getByLabelText(/company name/i) as HTMLInputElement).value).toBe('');
  });
});
