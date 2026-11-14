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

  it('the arrow keys keep the highlighted row scrolled into view', () => {
    const scroll = vi.fn();
    const before = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scroll;
    try {
      render(<AdminCommandPalette isOpen onClose={() => undefined} />);
      scroll.mockClear();
      fireEvent.keyDown(box(), { key: 'ArrowDown' });
      fireEvent.keyDown(box(), { key: 'ArrowDown' });
      expect(scroll).toHaveBeenLastCalledWith({ block: 'nearest' });
      expect((scroll.mock.contexts.at(-1) as HTMLElement).getAttribute('data-idx')).toBe('2');
    } finally {
      Element.prototype.scrollIntoView = before;
    }
  });
});

/**
 * A fetch that honours its AbortSignal, as the browser's does: each call waits until the test answers it, and
 * rejects with AbortError when aborted first. `late` answers with the body read deferred (the response was in hand
 * before the abort), so only the hook's own aborted-check can stop it.
 */
interface Pending { url: string; signal: AbortSignal; answer: (items: unknown[]) => void; late: (items: unknown[]) => () => void }
function pendingServe(): Pending[] {
  const calls: Pending[] = [];
  h.apiFetch.mockImplementation((url: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    const signal = init!.signal!;
    signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
    const body = (items: unknown[]) => ({ success: true, data: { items, total: items.length, page: 1, limit: 5 } });
    calls.push({
      url: String(url), signal,
      answer: (items) => resolve(reply(200, body(items))),
      late: (items) => {
        let release: () => void = () => undefined;
        const json = new Promise((r) => { release = () => r(body(items)); });
        resolve({ ok: true, status: 200, headers: new Headers(), json: () => json } as unknown as Response);
        return release;
      },
    });
  }));
  return calls;
}
const forQuery = (calls: Pending[], q: string, path: string) => calls.find(c => c.url.startsWith(path) && c.url.includes(`search=${q}&`))!;
const status = () => screen.getByRole('status').textContent;
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });

describe('AdminCommandPalette: stale replies and the live region', () => {
  it('a newer query aborts the older requests', async () => {
    const calls = pendingServe();
    render(<AdminCommandPalette isOpen onClose={() => undefined} />);
    await type('old');
    await type('new');
    expect(calls.filter(c => c.url.includes('search=old&')).map(c => c.signal.aborted)).toEqual([true, true]);
    expect(calls.filter(c => c.url.includes('search=new&')).map(c => c.signal.aborted)).toEqual([false, false]);
  });

  it('an older reply whose body lands after the newer reply does not replace it', async () => {
    const calls = pendingServe();
    render(<AdminCommandPalette isOpen onClose={() => undefined} />);
    await type('old');
    const releaseOld = forQuery(calls, 'old', '/api/admin/companies').late([{ ...COMPANY, id: 'co-old', name: 'Old Co' }]);
    forQuery(calls, 'old', '/api/admin/users').late([])();
    await type('new');
    forQuery(calls, 'new', '/api/admin/companies').answer([{ ...COMPANY, id: 'co-new', name: 'New Co' }]);
    forQuery(calls, 'new', '/api/admin/users').answer([]);
    await settle();
    expect(screen.getByText('New Co')).toBeTruthy();
    releaseOld();
    await settle();
    expect(screen.getByText('New Co')).toBeTruthy();
    expect(screen.queryByText('Old Co')).toBeNull();
  });

  it('an aborted request is not reported as a failed search', async () => {
    pendingServe();
    render(<AdminCommandPalette isOpen onClose={() => undefined} />);
    await type('acme');
    // Before the newer run starts (it would clear any error): the abort alone must not raise one.
    fireEvent.change(box(), { target: { value: 'acme ' } });
    await settle();
    expect(screen.queryByRole('alert')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('the previous query\'s records vanish as soon as the query changes', async () => {
    serve([COMPANY], []);
    render(<AdminCommandPalette isOpen onClose={() => undefined} />);
    await type('acme');
    expect(screen.getByText('Acme Holdings')).toBeTruthy();
    fireEvent.change(box(), { target: { value: 'acmex' } });
    expect(screen.queryByText('Acme Holdings')).toBeNull();
  });

  it('the live region says Searching while records load, even after an older run was aborted', async () => {
    const calls = pendingServe();
    render(<AdminCommandPalette isOpen onClose={() => undefined} />);
    await type('acme');
    expect(status()).toBe('Searching…');
    await type('acme ');
    await settle();
    expect(status()).toBe('Searching…');
    for (const c of calls.filter(c => !c.signal.aborted)) c.answer(c.url.startsWith('/api/admin/companies') ? [COMPANY] : [USER]);
    await settle();
    expect(status()).toBe('2 results');
  });

  it('the live region counts pages and records together, and says when the search failed', async () => {
    serve([COMPANY], []);
    render(<AdminCommandPalette isOpen onClose={() => undefined} />);
    await type('plans');
    expect(status()).toBe(`${screen.getAllByRole('option').length} results`);
    expect(screen.getAllByRole('option').length).toBe(2);
    cleanup();
    serve([], [], 500);
    render(<AdminCommandPalette isOpen onClose={() => undefined} />);
    await type('zzz');
    expect(status()).toBe('Search failed');
  });
});
