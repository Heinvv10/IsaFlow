// D2 round 5: admin companies create / bulk suspend / extend trial, company detail save, subscription cancel,
// RevenueIntelligenceSection and the useBankRules load. 400 -> server message; empty 500 -> a plain sentence; 200 -> completes.
import { act, cleanup, configure, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

configure({ asyncUtilTimeout: 4000 });
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/utils/toast', () => ({ notify: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { id: 'x-1' }, push: vi.fn(), replace: vi.fn(), pathname: '/' }) }));
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/hooks/useAdminPrefix', () => ({ useAdminHref: () => (p: string) => p }));

import { apiFetch } from '@/lib/apiFetch';
import CompaniesPage from '../../../pages/admin/companies/index';
import CompanyDetailPage from '../../../pages/admin/companies/[id]';
import SubscriptionsPage from '../../../pages/admin/billing/subscriptions';
import { RevenueIntelligenceSection } from '@/components/admin/RevenueIntelligenceSection';
import { useBankRules } from '@/components/accounting/bank-rules/useBankRules';

useApiJsonOverMock();
const MSG = 'D2 server says no: this request was refused';
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const bad400 = () => new Response(JSON.stringify({ success: false, error: { code: 'BAD_REQUEST', message: MSG } }), { status: 400 });
const empty500 = () => new Response('', { status: 500 });
const noRaw = () => expect(document.body.textContent ?? '').not.toMatch(/JSON|Unexpected end|HTTP \d|Failed to/);
type Fail = () => Response;
/** `target(path, method)` answers `fail`; everything else `rest(path, method)` (default empty list). */
function script(target: (p: string, m: string) => boolean, fail: Fail, rest: (p: string, m: string) => unknown = () => []) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url, init) => {
    const p = String(url).split('?')[0]!; const m = (init?.method ?? 'GET').toUpperCase();
    return target(p, m) ? fail() : ok(rest(p, m));
  });
}
/**
 * pages/admin/companies mounts with a 300 ms debounce that clears the selection and reloads the list (and clears
 * `error`). A test that selects a row and presses a bulk button takes however long the box lets it, so on a loaded
 * machine the debounce fired in the middle: the button vanished, or the error was wiped. The debounce is collapsed to
 * 0 ms, and `mountCompanies` drains it (both list loads, counted event-loop turns) before the test touches the page.
 */
const realSetTimeout = globalThis.setTimeout;
let timers: { mockRestore: () => void } | undefined;
beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  timers = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...a: unknown[]) =>
    realSetTimeout(fn, ms === 300 ? 0 : ms, ...a)) as typeof setTimeout);
});
afterEach(() => { cleanup(); timers?.mockRestore(); });
const turn = () => act(async () => { await new Promise<void>((r) => setImmediate(r)); });
async function mountCompanies() {
  const view = render(<CompaniesPage />);
  const lists = () => vi.mocked(apiFetch).mock.calls.filter(([u]) => String(u).startsWith('/api/admin/companies?')).length;
  for (let i = 0; i < 500 && lists() < 2; i += 1) await turn(); // the page effect's load and the debounced one
  for (let i = 0; i < 10; i += 1) await turn(); // let the second load's state land
  return view;
}

describe('admin companies: create, bulk suspend, extend trial', () => {
  const C = { id: 'c-1', name: 'D2 Acme Ltd', trading_name: null, plan_name: 'Starter', plan_code: 'starter', status: 'active', user_count: 1, mrr_cents: 0, created_at: '2026-01-01T00:00:00Z', last_active: null };
  const list = (p: string) => (p === '/api/admin/companies' ? { items: [C], total: 1, page: 1, limit: 25 } : []);
  const create = async (fail: Fail) => {
    script((p, m) => p === '/api/admin/companies' && m === 'POST', fail, list);
    const { container } = await mountCompanies();
    fireEvent.click(await screen.findByRole('button', { name: /add company/i }));
    fireEvent.change(container.querySelector('input[required]')!, { target: { value: 'New D2 Co' } });
    fireEvent.click(screen.getByRole('button', { name: /^create company$/i }));
  };
  it('create 400: the server message', async () => { await create(bad400); expect(await screen.findByText(MSG)).toBeTruthy(); });
  it('create empty 500: a plain sentence', async () => { await create(empty500); expect(await screen.findByText('Could not create the company - try again')).toBeTruthy(); noRaw(); });
  it('create 200: the modal closes and the list reloads', async () => {
    script(() => false, empty500, (p, m) => (p === '/api/admin/companies' && m === 'POST' ? { id: 'c-2' } : list(p)));
    const { container } = await mountCompanies();
    fireEvent.click(await screen.findByRole('button', { name: /add company/i }));
    fireEvent.change(container.querySelector('input[required]')!, { target: { value: 'New D2 Co' } });
    fireEvent.click(screen.getByRole('button', { name: /^create company$/i }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /^create company$/i })).toBeNull());
  });
  const bulk = async (label: RegExp, fail: Fail | null) => {
    script((p) => p.endsWith('/bulk-action'), fail ?? (() => ok({}) as Response), list);
    await mountCompanies();
    await screen.findAllByText('D2 Acme Ltd');
    fireEvent.click(screen.getAllByRole('checkbox').at(-1)!.closest('td')!);
    fireEvent.click(await screen.findByRole('button', { name: label }));
  };
  for (const [what, label, sentence] of [['bulk suspend', /bulk suspend/i, 'Could not suspend the companies - try again'], ['extend trial', /extend trial/i, 'Could not extend the trial - try again']] as const) {
    it(`${what} 400: the server message`, async () => { await bulk(label, bad400); expect(await screen.findByText(MSG)).toBeTruthy(); });
    it(`${what} empty 500: a plain sentence`, async () => { await bulk(label, empty500); expect(await screen.findByText(sentence)).toBeTruthy(); noRaw(); });
    it(`${what} 200: the selection clears`, async () => {
      script((p) => p.endsWith('/bulk-action') && false, empty500, list);
      await mountCompanies();
      await screen.findAllByText('D2 Acme Ltd');
      fireEvent.click(screen.getAllByRole('checkbox').at(-1)!.closest('td')!);
      fireEvent.click(await screen.findByRole('button', { name: label }));
      await waitFor(() => expect(screen.queryByRole('button', { name: label })).toBeNull());
    });
  }
});

describe('admin company detail: save', () => {
  const D = { id: 'x-1', name: 'D2 Acme Ltd', trading_name: null, registration_number: null, vat_number: null, email: null, phone: null, website: null,
    billing_email: null, billing_contact: null, address_line1: null, city: null, province: null, postal_code: null, plan_name: 'Starter',
    billing_cycle: 'monthly', status: 'active', created_at: '2026-01-01T00:00:00Z', last_active: null };
  const save = async (fail: Fail | null) => {
    script((p, m) => p === '/api/admin/companies/x-1' && m === 'PATCH', fail ?? empty500,
      (p, m) => (p === '/api/admin/companies/x-1' ? { ...D, ...(m === 'PATCH' ? { name: 'D2 Renamed Ltd' } : {}) } : []));
    if (!fail) vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      const p = String(url).split('?')[0]; return ok(p === '/api/admin/companies/x-1' ? { ...D, ...((init?.method ?? 'GET') === 'PATCH' ? { name: 'D2 Renamed Ltd' } : {}) } : []);
    });
    render(<CompanyDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /save changes/i }));
  };
  it('400: the server message', async () => { await save(bad400); expect(await screen.findByText(MSG)).toBeTruthy(); });
  it('empty 500: a plain sentence', async () => { await save(empty500); expect(await screen.findByText('Could not save the company - try again')).toBeTruthy(); noRaw(); });
  it('200: edit mode closes and the saved company shows', async () => {
    await save(null);
    expect((await screen.findAllByText('D2 Renamed Ltd')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /save changes/i })).toBeNull();
  });
});

describe('subscription cancel', () => {
  const S = { id: 'sub-1', company_id: 'x-1', company_name: 'D2 Acme Ltd', plan_id: 'p1', plan_name: 'Starter', plan_code: 'starter', status: 'active',
    billing_cycle: 'monthly', current_period_start: null, current_period_end: null, cancel_at_period_end: false, discount_percent: 0, monthly_amount_cents: 100, created_at: '2026-01-01T00:00:00Z' };
  const list = (p: string) => (p === '/api/admin/billing/subscriptions' ? { items: [S], total: 1, page: 1, limit: 25 } : []);
  const cancel = async (fail: Fail) => {
    script((p) => p.endsWith('/cancel'), fail, list);
    render(<SubscriptionsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^cancel$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /confirm|yes/i }));
  };
  it('400: the server message', async () => { await cancel(bad400); expect(await screen.findByText(MSG)).toBeTruthy(); });
  it('empty 500: a plain sentence', async () => { await cancel(empty500); expect(await screen.findByText('Could not cancel the subscription - try again')).toBeTruthy(); noRaw(); });
  it('200: the confirm closes and the list reloads', async () => {
    script(() => false, empty500, (p, m) => (m === 'POST' ? {} : list(p)));
    render(<SubscriptionsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^cancel$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /confirm|yes/i }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /confirm|yes/i })).toBeNull());
  });
});

describe('RevenueIntelligenceSection', () => {
  const open = (fail: Fail | null) => {
    vi.mocked(apiFetch).mockReset().mockImplementation(async () => fail ? fail() : ok({ plan_breakdown: [], churn_trend: [], nrr: 117, arpu_cents: 123400, ltv_estimate_cents: 0, cohort_retention: [] }));
    render(<RevenueIntelligenceSection />);
  };
  it('400: the server message', async () => { open(bad400); expect(await screen.findByText(MSG)).toBeTruthy(); });
  it('empty 500: a plain sentence', async () => { open(empty500); expect(await screen.findByText('Could not load the revenue data - try again')).toBeTruthy(); noRaw(); });
  it('200: the figures render', async () => { open(null); expect(await screen.findByText('117%')).toBeTruthy(); });
});

const fetchPreview = async () => 0;   // stable identity: the hook's preview effect depends on it
describe('useBankRules load', () => {
  const mount = async (fail: Fail | null) => {
    vi.mocked(apiFetch).mockReset().mockImplementation(async () => fail ? fail() : ok({ items: [{ id: 'r1', ruleName: 'D2 Rule 77', matchField: 'description', matchType: 'contains', matchPattern: 'x', priority: 1 }] }));
    const hook = renderHook(() => useBankRules({ defaultBankId: 'bank-1', fetchPreview }));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    return hook.result.current;
  };
  it('400: the error field carries the server message', async () => { expect((await mount(bad400)).error).toBe(MSG); });
  it('empty 500: a plain sentence, not "HTTP 500"', async () => { expect((await mount(empty500)).error).toBe('Could not load the rules - try again'); });
  it('200: the rules load', async () => { const r = await mount(null); expect(r.error).toBe(''); expect(r.rules[0]?.ruleName).toBe('D2 Rule 77'); });
});
