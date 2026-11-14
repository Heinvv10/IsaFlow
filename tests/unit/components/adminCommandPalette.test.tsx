/**
 * Admin audit 2026-11-14, item 4.3: Ctrl+K on the admin host finds admin pages, companies and users through the
 * existing admin list APIs (/api/admin/companies, /api/admin/users), never the tenant global search.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const h = vi.hoisted(() => ({ push: vi.fn(), apiFetch: vi.fn() }));
vi.mock('next/router', () => ({ useRouter: () => ({ push: h.push, asPath: '/admin', pathname: '/admin', query: {} }) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/apiFetch', async (orig) => ({ ...(await orig<typeof import('@/lib/apiFetch')>()), apiFetch: (...a: unknown[]) => h.apiFetch(...a) }));

import { AdminCommandPalette } from '@/components/admin/AdminCommandPalette';

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const COMPANY = { id: 'co-1', name: 'Acme Holdings', trading_name: 'Acme', status: 'active' };
const USER = { id: 'u-1', first_name: 'Ann', last_name: 'Acker', email: 'ann@acme.test', role: 'admin' };
function serve(companies: unknown[], users: unknown[], status = 200) {
  h.apiFetch.mockImplementation(async (url: string) => {
    if (status !== 200) return reply(status, { success: false });
    const items = String(url).startsWith('/api/admin/companies') ? companies : users;
    return reply(200, { success: true, data: { items, total: items.length, page: 1, limit: 5 } });
  });
}
const box = () => screen.getByRole('combobox');
async function type(text: string) {
  fireEvent.change(box(), { target: { value: text } });
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
}

beforeEach(() => { vi.useFakeTimers(); h.push.mockReset(); h.apiFetch.mockReset(); serve([], []); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('AdminCommandPalette', () => {
  it('is a modal dialog with a focused combobox, and Escape closes it', () => {
    const onClose = vi.fn();
    render(<AdminCommandPalette isOpen onClose={onClose} />);
    expect(screen.getByRole('dialog').getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(box());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('with no query lists admin pages, none of them an accounting page', () => {
    render(<AdminCommandPalette isOpen onClose={() => undefined} />);
    const titles = screen.getAllByRole('option').map(o => o.textContent ?? '');
    expect(titles.some(t => t.includes('Companies'))).toBe(true);
    expect(titles.some(t => /Sales|Purchases|Banking/.test(t))).toBe(false);
  });

  it('"traffic" finds Web Traffic with its section as the trail, and Enter opens it', async () => {
    render(<AdminCommandPalette isOpen onClose={() => undefined} />);
    await type('traffic');
    const first = screen.getAllByRole('option')[0]!;
    expect(first.textContent).toContain('Web Traffic');
    expect(first.textContent).toContain('Analytics');
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(h.push).toHaveBeenCalledWith('/admin/web-analytics');
  });

  it('searches companies and users through the admin list APIs and opens the chosen record', async () => {
    serve([COMPANY], [USER]);
    const onClose = vi.fn();
    render(<AdminCommandPalette isOpen onClose={onClose} />);
    await type('acme');
    const urls = h.apiFetch.mock.calls.map(([u]) => String(u));
    expect(urls).toEqual(expect.arrayContaining(['/api/admin/companies?search=acme&limit=5', '/api/admin/users?search=acme&limit=5']));
    expect(urls.some(u => u.includes('global-search'))).toBe(false);
    expect(screen.getByRole('option', { name: /Acme Holdings/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('option', { name: /Ann Acker/ }));
    expect(h.push).toHaveBeenCalledWith('/admin/users/u-1');
    expect(onClose).toHaveBeenCalled();
  });

  it('a company row opens the company page', async () => {
    serve([COMPANY], []);
    render(<AdminCommandPalette isOpen onClose={() => undefined} />);
    await type('acme');
    fireEvent.click(screen.getByRole('option', { name: /Acme Holdings/ }));
    expect(h.push).toHaveBeenCalledWith('/admin/companies/co-1');
  });

  it('one character does not reach the server', async () => {
    render(<AdminCommandPalette isOpen onClose={() => undefined} />);
    await type('a');
    expect(h.apiFetch).not.toHaveBeenCalled();
  });

  it('a failed search says so instead of showing "no results"', async () => {
    serve([], [], 500);
    render(<AdminCommandPalette isOpen onClose={() => undefined} />);
    await type('zzz');
    expect(screen.getByRole('alert').textContent).toMatch(/could not search/i);
    expect(screen.queryByText(/No results/)).toBeNull();
  });

  it('a reply to an older query never shows under a newer one', async () => {
    const pending: Array<() => void> = [];
    h.apiFetch.mockImplementation((url: string) => new Promise<Response>((resolve) => {
      const items = String(url).includes('search=old') && String(url).startsWith('/api/admin/companies') ? [{ ...COMPANY, name: 'Old Co' }] : [];
      pending.push(() => resolve(reply(200, { success: true, data: { items, total: items.length, page: 1, limit: 5 } })));
    }));
    render(<AdminCommandPalette isOpen onClose={() => undefined} />);
    await type('old');
    await type('new');
    // The newer reply lands first, the older one last: the late one must not replace it.
    await act(async () => { for (const r of [...pending].reverse()) r(); await vi.advanceTimersByTimeAsync(0); });
    expect(screen.queryByText('Old Co')).toBeNull();
  });
});
