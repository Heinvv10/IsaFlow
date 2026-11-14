/**
 * Admin "Export CSV" (audit 3.8): every export link carries the filters the page
 * shows, so the file holds what the admin filtered to, all pages of it. The Audit
 * Trail export goes to the server (every matching entry) instead of serialising
 * the 50 rows on screen; the Web Traffic CSV follows the Bots toggle.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { mockedApiFetchModule, useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn(), replace: vi.fn(), pathname: '/' }) }));
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import { apiFetch } from '@/lib/apiFetch';
import UsersPage from '../../../pages/admin/users/index';
import CompaniesPage from '../../../pages/admin/companies/index';
import SubscriptionsPage from '../../../pages/admin/billing/subscriptions';
import AuditPage from '../../../pages/admin/audit';
import WebAnalyticsPage from '../../../pages/admin/web-analytics';

void mockedApiFetchModule;
useApiJsonOverMock();

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const empty = { items: [], total: 0, page: 1, limit: 25, total_pages: 0 };

beforeEach(() => {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => {
    const path = String(url).split('?')[0];
    if (path === '/api/admin/analytics/web/websites') {
      return json({ success: true, data: { websites: [{ id: 'site-1', name: 'Site', domain: null, category: 'marketing' }] } });
    }
    if (path === '/api/admin/analytics/web/summary' || path === '/api/admin/analytics/web/realtime') {
      return json({ success: true, data: null });
    }
    return json({ success: true, data: empty });
  });
});
afterEach(() => { cleanup(); });

function exportParams(name: RegExp = /Export CSV/): { path: string; params: URLSearchParams } {
  const href = screen.getByRole('link', { name }).getAttribute('href') ?? '';
  const [path, qs] = href.split('?');
  return { path: path!, params: new URLSearchParams(qs ?? '') };
}

describe('admin export links carry the active filters', () => {
  it('users: search, company and status', async () => {
    render(<UsersPage />);
    fireEvent.change(screen.getByPlaceholderText('Search name or email...'), { target: { value: 'ann' } });
    fireEvent.change(screen.getByPlaceholderText('Filter by company...'), { target: { value: 'Acme' } });
    fireEvent.change(screen.getByDisplayValue('All statuses'), { target: { value: 'suspended' } });
    await waitFor(() => expect(exportParams().params.get('status')).toBe('suspended'));
    const { path, params } = exportParams();
    expect(path).toBe('/api/admin/users/export');
    expect(Object.fromEntries(params)).toEqual({ search: 'ann', company: 'Acme', status: 'suspended' });
  });

  it('companies: search, status and the sort on screen', async () => {
    render(<CompaniesPage />);
    fireEvent.change(screen.getByPlaceholderText('Search companies...'), { target: { value: 'Acme' } });
    fireEvent.change(screen.getByDisplayValue('All statuses'), { target: { value: 'active' } });
    await waitFor(() => expect(exportParams().params.get('status')).toBe('active'));
    const { path, params } = exportParams();
    expect(path).toBe('/api/admin/companies/export');
    expect(Object.fromEntries(params)).toEqual({ search: 'Acme', status: 'active', sort_by: 'created_at', sort_dir: 'desc' });
  });

  it('subscriptions: search and status', async () => {
    render(<SubscriptionsPage />);
    fireEvent.change(screen.getByPlaceholderText('Search company...'), { target: { value: 'Acme' } });
    fireEvent.change(screen.getByDisplayValue('All statuses'), { target: { value: 'active' } });
    await waitFor(() => expect(exportParams().params.get('status')).toBe('active'));
    const { path, params } = exportParams();
    expect(path).toBe('/api/admin/billing/subscriptions/export');
    expect(Object.fromEntries(params)).toEqual({ search: 'Acme', status: 'active' });
  });

  it('audit trail: the server export with every filter, not the rows on screen', async () => {
    render(<AuditPage />);
    fireEvent.change(screen.getByDisplayValue('All Sources'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByPlaceholderText('Email, ref, or action…'), { target: { value: 'ann' } });
    await waitFor(() => expect(exportParams().params.get('search')).toBe('ann'));
    const { path, params } = exportParams();
    expect(path).toBe('/api/admin/audit/export');
    expect(params.get('source')).toBe('admin');
    expect(params.get('from_date')).toMatch(/^\d{4}-\d{2}-01$/);
    expect(params.get('to_date')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('web traffic: the CSV follows the Bots toggle', async () => {
    render(<WebAnalyticsPage />);
    await waitFor(() => expect(exportParams(/CSV/).params.get('website_id')).toBe('site-1'));
    expect(exportParams(/CSV/).params.get('include_bots')).toBeNull();
    fireEvent.click(screen.getByTitle('Toggle crawler/bot traffic'));
    await waitFor(() => expect(exportParams(/CSV/).params.get('include_bots')).toBe('1'));
    expect(exportParams(/CSV/).path).toBe('/api/admin/analytics/web/export');
  });
});

describe('companies: Export CSV of the selected rows neutralises formula cells', () => {
  it('a company name or plan starting with = + - @ is written as text', async () => {
    const row = { id: 'c-1', name: '=HYPERLINK("http://evil.invalid","x")', trading_name: null, plan_name: '+Plan', plan_code: 'p',
      status: 'active', user_count: 1, mrr_cents: 12345, created_at: '2026-10-01T10:00:00Z', last_active: null };
    vi.mocked(apiFetch).mockImplementation(async () => json({ success: true, data: { items: [row], total: 1, page: 1, limit: 25 } }));
    const blobs: Blob[] = [];
    const made = vi.spyOn(URL, 'createObjectURL').mockImplementation((b: Blob | MediaSource) => { blobs.push(b as Blob); return 'blob:wp10'; });
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    onTestFinished(() => { made.mockRestore(); revoked.mockRestore(); });
    render(<CompaniesPage />);
    // The mount load, then the 300 ms debounced load, which clears any selection made before it.
    await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 3000 });
    // The cell, not the box: a click on the box also bubbles to the cell's own toggle (two toggles, no change).
    fireEvent.click((await screen.findByLabelText(`Select ${row.name}`)).closest('td')!);
    fireEvent.click(screen.getByRole('button', { name: /Export CSV/ }));
    expect(blobs).toHaveLength(1);
    const text = await blobs[0]!.text();
    expect(text).toContain(`"'=HYPERLINK(""http://evil.invalid"",""x"")"`);
    expect(text).toContain(`"'+Plan"`);
    expect(text).not.toMatch(/(^|,)"?[=+]/m);
  });
});
