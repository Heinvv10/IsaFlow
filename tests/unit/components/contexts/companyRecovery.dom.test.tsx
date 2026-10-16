/**
 * Recovery for a session already pointed at a company the server will no
 * longer serve (incident 2026-10-16).
 *
 * The sign-in fixes stop new sessions reaching that state; these cover the
 * sessions already in it. When the company-scoped user-companies call 403s,
 * the provider has neither an active company nor a list to switch with, so it
 * asks the user-scoped `/api/auth/me` for a live membership and re-points the
 * cookie through `switch-company` — ONCE per provider instance, so a switch
 * that does not help cannot become a loop.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ isAuthenticated: true, user: { id: 'u1', role: 'owner' }, loading: false }),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { CompanyProvider, useCompany } from '@/contexts/CompanyContext';

function Probe() {
  const { activeCompany, companies, loading } = useCompany();
  return (
    <div>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="company">{activeCompany?.id ?? 'none'}</span>
      <span data-testid="count">{companies.length}</span>
    </div>
  );
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

let fetchMock: ReturnType<typeof vi.fn>;

// Some happy-dom/vitest combinations hand the test a window without Storage.
// The provider's helpers only guard the READS, so give it a working store
// rather than let an unrelated environment gap decide this file's result.
if (typeof window !== 'undefined' && !window.localStorage) {
  const store = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    },
  });
}

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('CompanyProvider — stuck-session recovery', () => {
  it('switches to a live company when user-companies 403s, then shows it', async () => {
    let userCompaniesCalls = 0;
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('action=user-companies')) {
        userCompaniesCalls += 1;
        // First call: the cookie still names the soft-deleted company, so
        // withAuth refuses the whole request.
        if (userCompaniesCalls === 1) return json({ success: false }, 403);
        return json({ success: true, data: { items: [{ company_id: 'live', company_name: 'Live Co', role: 'owner', is_default: true }], activeCompanyId: 'live' } });
      }
      if (url.includes('/api/auth/me')) {
        return json({ success: true, data: { memberships: [{ company_id: 'live', name: 'Live Co', role: 'owner', is_default: true }] } });
      }
      if (url.includes('/api/auth/switch-company')) {
        expect(JSON.parse(String(init?.body))).toEqual({ companyId: 'live' });
        return json({ success: true, data: { activeCompanyId: 'live' } });
      }
      if (url.includes('/api/accounting/companies?id=')) {
        return json({ success: true, data: { id: 'live', name: 'Live Co' } });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { getByTestId } = render(<CompanyProvider><Probe /></CompanyProvider>);

    await waitFor(() => expect(getByTestId('company').textContent).toBe('live'));
    expect(getByTestId('loading').textContent).toBe('false');
    expect(getByTestId('count').textContent).toBe('1');
    expect(userCompaniesCalls).toBe(2);
  });

  it('settles into the no-company state (never a loop) when there is nothing to recover to', async () => {
    const calls: string[] = [];
    fetchMock = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes('action=user-companies')) return json({ success: false }, 403);
      if (url.includes('/api/auth/me')) return json({ success: true, data: { memberships: [] } });
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { getByTestId } = render(<CompanyProvider><Probe /></CompanyProvider>);

    await waitFor(() => expect(getByTestId('loading').textContent).toBe('false'));
    expect(getByTestId('company').textContent).toBe('none');
    // No live membership → no switch attempted, and the failed list is not retried.
    expect(calls.filter((c) => c.includes('switch-company'))).toHaveLength(0);
    expect(calls.filter((c) => c.includes('action=user-companies'))).toHaveLength(1);
  });

  it('does not touch /api/auth/me on the normal path', async () => {
    const calls: string[] = [];
    fetchMock = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes('action=user-companies')) {
        return json({ success: true, data: { items: [{ company_id: 'c1', company_name: 'C1', role: 'owner', is_default: true }], activeCompanyId: 'c1' } });
      }
      if (url.includes('/api/accounting/companies?id=')) return json({ success: true, data: { id: 'c1', name: 'C1' } });
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { getByTestId } = render(<CompanyProvider><Probe /></CompanyProvider>);

    await waitFor(() => expect(getByTestId('company').textContent).toBe('c1'));
    expect(calls.some((c) => c.includes('/api/auth/me'))).toBe(false);
    expect(calls.some((c) => c.includes('switch-company'))).toBe(false);
  });
});
