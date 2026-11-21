/**
 * A user without Payroll read does not see Payroll in the nav (top bar, mobile drawer, sidebar, command palette).
 * Real `useNavFlags` over a faked `/api/accounting/my-permissions`: the Payroll tab is hidden until the answer says
 * the user can read it, and stays hidden when the answer is no or never comes. Hiding is cosmetic; the APIs decide.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { Tab } from '@/components/accounting/navSections/types';

const h = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  moduleTabs: [] as Tab[][],
}));
vi.mock('next/router', () => ({ useRouter: () => ({ pathname: '/accounting', asPath: '/accounting', query: {} }) }));
vi.mock('@/hooks/useVatRegistration', () => ({ useVatRegistration: () => ({ isRegistered: true, known: true }) }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ activeCompany: { id: 'co-1' } }) }));
vi.mock('@/lib/apiFetch', async (orig) => ({ ...(await orig<typeof import('@/lib/apiFetch')>()), apiFetch: h.apiFetch }));
vi.mock('@/components/layout/ModuleNav', () => ({
  ModuleNav: ({ tabs }: { tabs: Tab[] }) => { h.moduleTabs.push(tabs); return null; },
}));

import { AccountingNav } from '@/components/accounting/AccountingNav';
import { DrawerNav } from '@/components/layout/DrawerNav';
import { NAV_FLAGS_BACKOFF_MS, resetNavFlagsCache, useNavFlags } from '@/hooks/useNavFlags';
import { AuthContext } from '@/contexts/AuthContext';
import { moduleReadFlag, NAV_FLAGS } from '@/components/accounting/navSections/flagNav';
import { buildSections } from '@/components/layout/paletteRank';
import { PALETTE_ACTIONS } from '@/components/layout/commandActions';

type Perm = { read: boolean; write: boolean; approve: boolean };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** Fake the two nav endpoints: features off, my-permissions as given (or a failure). */
function server(payroll: Perm | 'fail' | 'hang'): void {
  h.apiFetch.mockImplementation((url: string) => {
    if (url.startsWith('/api/accounting/my-permissions')) {
      if (payroll === 'hang') return new Promise<Response>(() => undefined);
      if (payroll === 'fail') return Promise.resolve(json({ success: false, error: 'no' }, 500));
      return Promise.resolve(json({ success: true, data: { modules: { payroll, customers: { read: true, write: true, approve: false } } } }));
    }
    return Promise.resolve(json({ success: true, data: { enabled: false } }));
  });
}

const tabIds = () => (h.moduleTabs.at(-1) ?? []).map((t) => t.id);

beforeEach(() => { resetNavFlagsCache(); h.moduleTabs = []; h.apiFetch.mockReset(); });
afterEach(() => { cleanup(); });

describe('AccountingNav (the top bar)', () => {
  it('shows Payroll once the user can read it', async () => {
    server({ read: true, write: true, approve: false });
    render(<AccountingNav />);
    await waitFor(() => expect(tabIds()).toContain('payroll'));
  });

  it('hides Payroll for a user without Payroll read, and keeps the other tabs', async () => {
    server({ read: false, write: false, approve: false });
    render(<AccountingNav />);
    await waitFor(() => expect(h.apiFetch).toHaveBeenCalledWith(expect.stringContaining('/api/accounting/my-permissions')));
    await waitFor(() => expect(tabIds()).toContain('sales'));
    expect(tabIds()).not.toContain('payroll');
  });

  it('does not flash Payroll in before the answer: the first render has no Payroll tab', async () => {
    server({ read: true, write: false, approve: false });
    render(<AccountingNav />);
    expect(h.moduleTabs[0]!.map((t) => t.id)).not.toContain('payroll');
    await waitFor(() => expect(tabIds()).toContain('payroll'));
  });

  it('keeps Payroll hidden while the answer is pending', async () => {
    server('hang');
    render(<AccountingNav />);
    await waitFor(() => expect(h.apiFetch).toHaveBeenCalled());
    expect(h.moduleTabs.every((tabs) => !tabs.some((t) => t.id === 'payroll'))).toBe(true);
  });

  it('keeps Payroll hidden when the permissions request fails', async () => {
    server('fail');
    render(<AccountingNav />);
    await waitFor(() => expect(h.apiFetch).toHaveBeenCalledWith(expect.stringContaining('/api/accounting/my-permissions')));
    await new Promise((r) => setTimeout(r, 20));
    expect(tabIds()).not.toContain('payroll');
  });
});

describe('a failed permissions request is asked again only after the backoff', () => {
  const asked = () => h.apiFetch.mock.calls.filter(([u]) => String(u).startsWith('/api/accounting/my-permissions')).length;

  it('a mount inside the backoff does not re-ask; the first mount after it does, and shows Payroll when the answer is yes', async () => {
    const realNow = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(realNow);
    try {
      server('fail');
      const first = render(<AccountingNav />);
      await waitFor(() => expect(asked()).toBe(1));
      await new Promise((r) => setTimeout(r, 20));
      first.unmount();

      server({ read: true, write: false, approve: false });
      const second = render(<AccountingNav />);
      await new Promise((r) => setTimeout(r, 20));
      expect(asked()).toBe(1);
      expect(tabIds()).not.toContain('payroll');
      second.unmount();

      now.mockReturnValue(realNow + NAV_FLAGS_BACKOFF_MS + 1);
      h.moduleTabs = [];
      render(<AccountingNav />);
      await waitFor(() => expect(tabIds()).toContain('payroll'));
      expect(asked()).toBe(2);
    } finally { now.mockRestore(); }
  });
});

describe('the two answers are independent', () => {
  const featuresOn = (perm: 'fail' | Perm) => h.apiFetch.mockImplementation((url: string) => {
    if (url.startsWith('/api/accounting/my-permissions')) {
      return Promise.resolve(perm === 'fail' ? json({ success: false }, 500) : json({ success: true, data: { modules: { payroll: perm } } }));
    }
    return Promise.resolve(json({ success: true, data: { enabled: true } }));
  });

  it('a failed permissions request hides Payroll only: the feature-flagged links stay', async () => {
    featuresOn('fail');
    const { result } = renderHook(() => useNavFlags());
    await waitFor(() => expect(result.current.has('budgets_three_way')).toBe(true));
    expect(result.current.has(moduleReadFlag('payroll'))).toBe(false);
  });

  it('a failed feature check hides the flagged links only: Payroll stays for a user who can read it', async () => {
    h.apiFetch.mockImplementation((url: string) => (url.startsWith('/api/accounting/my-permissions')
      ? Promise.resolve(json({ success: true, data: { modules: { payroll: { read: true, write: false, approve: false } } } }))
      : Promise.resolve(json({ success: false }, 500))));
    const { result } = renderHook(() => useNavFlags());
    await waitFor(() => expect(result.current.has(moduleReadFlag('payroll'))).toBe(true));
    expect(result.current.has('budgets_three_way')).toBe(false);
  });

  it('both answers in: both apply', async () => {
    featuresOn({ read: true, write: false, approve: false });
    const { result } = renderHook(() => useNavFlags());
    await waitFor(() => expect(result.current.has(moduleReadFlag('payroll'))).toBe(true));
    expect(result.current.has('budgets_three_way')).toBe(true);
  });
});

describe('the cache is per company AND user', () => {
  const as = (id: string) => ({ children }: { children: React.ReactNode }) => <AuthContext.Provider value={{ user: { id } } as never}>{children}</AuthContext.Provider>;
  it("a second user on the same page and company does not inherit the first user's Payroll", async () => {
    server({ read: true, write: false, approve: false });
    const first = renderHook(() => useNavFlags(), { wrapper: as('user-1') });
    await waitFor(() => expect(first.result.current.has(moduleReadFlag('payroll'))).toBe(true));
    first.unmount();

    server({ read: false, write: false, approve: false });
    const second = renderHook(() => useNavFlags(), { wrapper: as('user-2') });
    await waitFor(() => expect(h.apiFetch.mock.calls.filter(([u]) => String(u).startsWith('/api/accounting/my-permissions'))).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 20));
    expect(second.result.current.has(moduleReadFlag('payroll'))).toBe(false);
  });
  it('the same user is served from the cache', async () => {
    server({ read: true, write: false, approve: false });
    const a = renderHook(() => useNavFlags(), { wrapper: as('user-1') });
    await waitFor(() => expect(a.result.current.has(moduleReadFlag('payroll'))).toBe(true));
    a.unmount();
    const b = renderHook(() => useNavFlags(), { wrapper: as('user-1') });
    expect(b.result.current.has(moduleReadFlag('payroll'))).toBe(true);
    expect(h.apiFetch.mock.calls.filter(([u]) => String(u).startsWith('/api/accounting/my-permissions'))).toHaveLength(1);
  });
});

describe('DrawerNav (mobile)', () => {
  it('lists no Payroll entry without Payroll read, one with it', async () => {
    server({ read: false, write: false, approve: false });
    const first = render(<DrawerNav />);
    await waitFor(() => expect(h.apiFetch).toHaveBeenCalledWith(expect.stringContaining('/api/accounting/my-permissions')));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('button', { name: 'Payroll' })).toBeNull();
    expect(screen.queryByRole('link', { name: /Pay Runs|Payroll Runs/ })).toBeNull();
    first.unmount();

    resetNavFlagsCache();
    server({ read: true, write: false, approve: false });
    render(<DrawerNav />);
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Payroll' }).length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByRole('button', { name: 'Payroll' })[0]!);
  });
});

describe('command palette rows', () => {
  const index: never[] = [];
  const base = { query: 'new', index, recent: [], server: [] };
  const urls = (flags?: ReadonlySet<string>) => buildSections({ ...base, flags })
    .flatMap((s) => s.rows.map((r) => (r.kind === 'item' ? r.item.url : r.action.url)))
    .filter((u): u is string => Boolean(u));

  it('drops the New employee / New pay run actions without Payroll read', () => {
    expect(PALETTE_ACTIONS.some((a) => a.url?.startsWith('/payroll'))).toBe(true);
    const flags = new Set(NAV_FLAGS.filter((f) => !f.startsWith('module_read:')));
    expect(urls(flags).filter((u) => u.startsWith('/payroll'))).toEqual([]);
    expect(urls(flags)).toContain('/accounting/customer-invoices/new');
  });

  it('keeps them with Payroll read', () => {
    expect(urls(new Set(NAV_FLAGS)).filter((u) => u.startsWith('/payroll')).length).toBe(2);
  });

  it('drops payroll records and recents the server or storage hands back', () => {
    const emp = { type: 'employee', id: 'e1', title: 'Jane', subtitle: '', url: '/payroll/employees/e1', icon: 'user' };
    const inv = { type: 'invoice', id: 'i1', title: 'INV-1', subtitle: '', url: '/accounting/customer-invoices/i1', icon: 'file' };
    const out = buildSections({ query: 'j', index, recent: [], server: [emp, inv], flags: new Set() })
      .flatMap((s) => s.rows).map((r) => (r.kind === 'item' ? r.item.url : ''));
    expect(out).toContain(inv.url);
    expect(out).not.toContain(emp.url);
  });
});
