/**
 * D2 round 6 (g2): a failed load/reload clears the stale rows, a refused or non-JSON answer is a plain sentence,
 * and after a GOOD write whose reload fails the page still says the write succeeded.
 * Pages: report builder, customer report, webhooks, admin subscriptions, trial balance (reference data).
 */
import { typeDate, dateFieldInputs } from '../helpers/dateFields';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

configure({ asyncUtilTimeout: 4000 });
const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn, debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, isReady: true, push: vi.fn(), replace: vi.fn(), pathname: '/' }) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/hooks/useAdminPrefix', () => ({ useAdminHref: () => (p: string) => p }));
const company = vi.hoisted(() => ({ activeCompany: { id: 'co-1', name: 'D2 Co' } }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => company }));
vi.mock('@/components/accounting/reports/ReportBuilderFilters', () => ({ ReportBuilderFilters: () => null }));
vi.mock('@/components/accounting/reports/ReportBuilderPreview', () => ({
  ReportBuilderPreview: (p: { rows: unknown[] }) => <div data-testid="preview-rows">{p.rows.length}</div>,
}));
vi.mock('@/components/accounting/reports/ReportBuilderSidebar', () => ({
  ReportBuilderSidebar: (p: { onSourceChange: (s: string) => void; onAddField: (f: unknown) => void }) => (
    <div>
      <button onClick={() => p.onSourceChange('invoices')}>pick-source</button>
      <button onClick={() => p.onAddField({ field: 'f1', label: 'F1', type: 'text', filterable: true })}>add-col</button>
    </div>
  ),
}));
vi.mock('@/components/accounting/webhooks/WebhookForm', () => ({ WebhookForm: () => null }));
vi.mock('@/components/accounting/webhooks/WebhookCard', () => ({
  WebhookCard: (p: { webhook: { name: string }; onDelete: () => void }) => (
    <div><span>{p.webhook.name}</span><button onClick={p.onDelete}>delete-{p.webhook.name}</button></div>
  ),
}));
vi.mock('@/components/accounting/evidence/EvidenceDrillModal', () => ({ EvidenceDrillModal: () => null }));

import { apiFetch } from '@/lib/apiFetch';
import Builder from '../../../pages/accounting/reports/builder';
import CustomerReports from '../../../pages/accounting/reports/customer-reports';
import WebhooksPage from '../../../pages/accounting/webhooks';
import SubscriptionsPage from '../../../pages/admin/billing/subscriptions';
import TrialBalancePage from '../../../pages/accounting/trial-balance/index';

useApiJsonOverMock();
const MSG = 'D2 server says no: this request was refused';
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const bad400 = () => new Response(JSON.stringify({ success: false, error: { code: 'BAD_REQUEST', message: MSG } }), { status: 400 });
const empty500 = () => new Response('', { status: 500 });
const noRaw = () => expect(document.body.textContent ?? '').not.toMatch(/JSON|Unexpected end|HTTP \d|Failed to|Network error/);
beforeEach(() => { vi.mocked(apiFetch).mockReset(); warn.mockClear(); });
afterEach(() => { cleanup(); });

describe('report builder: a failed run clears the previous result', () => {
  const run = async (second: () => Response) => {
    let runs = 0;
    vi.mocked(apiFetch).mockImplementation(async (url: unknown) => {
      if (!String(url).includes('custom-reports-run')) return ok({ fields: [] });
      return ++runs === 1 ? ok({ columns: [], rows: [{ f1: 'a' }, { f1: 'b' }], totals: {}, rowCount: 2 }) : second();
    });
    render(<Builder />);
    fireEvent.click(screen.getByText('pick-source'));
    fireEvent.click(screen.getByText('add-col'));
    fireEvent.click(screen.getByRole('button', { name: /^run$/i }));
    await waitFor(() => expect(screen.getByTestId('preview-rows').textContent).toBe('2'));
    fireEvent.click(screen.getByRole('button', { name: /^run$/i }));
  };
  it('400: the server message and no stale rows', async () => {
    await run(bad400);
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(screen.getByTestId('preview-rows').textContent).toBe('0');
  });
  it('empty 500: a plain sentence and no stale rows', async () => {
    await run(empty500);
    expect(await screen.findByText('Could not run the report - try again')).toBeTruthy();
    expect(screen.getByTestId('preview-rows').textContent).toBe('0');
    noRaw();
  });
  it('a 200 with no data is a failure, not a crash', async () => {
    await run(() => ok(undefined));
    expect(await screen.findByText('Could not run the report - try again')).toBeTruthy();
    expect(screen.getByTestId('preview-rows').textContent).toBe('0');
  });
});

describe('customer report: a failed reload clears the rows, shows no "No data for period", Export disabled', () => {
  const row = { clientId: 'c1', clientName: 'D2 Acme Ltd', invoiceCount: 1, totalInvoiced: 100, totalPaid: 0, balance: 100 };
  const load = async (second: () => Response) => {
    let loads = 0;
    vi.mocked(apiFetch).mockImplementation(async () => (++loads === 1 ? ok([row]) : second()));
    const { container } = render(<CustomerReports />);
    await screen.findByText('D2 Acme Ltd');
    typeDate(dateFieldInputs(container)[0]!, '2026-01-02');
  };
  it('400', async () => {
    await load(bad400);
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(screen.queryByText('D2 Acme Ltd')).toBeNull();
    expect(screen.queryByText('No data for period')).toBeNull();
    expect((screen.getByText(/Export CSV/).closest('button') as HTMLButtonElement).disabled).toBe(true);
  });
  it('empty 500', async () => {
    await load(empty500);
    expect(await screen.findByText('Could not load the customer report - try again')).toBeTruthy();
    expect(screen.queryByText('D2 Acme Ltd')).toBeNull();
    noRaw();
  });
});

describe('webhooks', () => {
  const W = { id: 'w1', name: 'D2 Hook', url: 'https://x.invalid', events: ['a'], isActive: true };
  const open = async (reload: () => Response, onDelete: () => Response = () => ok({})) => {
    let gets = 0;
    vi.mocked(apiFetch).mockImplementation(async (_u: unknown, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'DELETE') return onDelete();
      return ++gets === 1 ? ok([W]) : reload();
    });
    vi.stubGlobal('confirm', () => true);
    render(<WebhooksPage />);
    fireEvent.click(await screen.findByText('delete-D2 Hook'));
  };
  afterEach(() => { vi.unstubAllGlobals(); });
  it('deleted, then the reload fails: still says it was deleted, the stale row is gone', async () => {
    await open(empty500);
    expect(await screen.findByText('The webhook was deleted, but the list could not be refreshed - reload the page')).toBeTruthy();
    expect(screen.queryByText('D2 Hook')).toBeNull();
    expect(screen.queryByText('No webhooks configured')).toBeNull();
  });
  it('delete refused: the server message and the row stays', async () => {
    await open(() => ok([W]), bad400);
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(screen.getByText('D2 Hook')).toBeTruthy();
  });
  it('the first load refused: the message, not a "No webhooks configured" empty state', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => empty500());
    render(<WebhooksPage />);
    expect(await screen.findByText('Could not load the webhooks - try again')).toBeTruthy();
    expect(screen.queryByText('No webhooks configured')).toBeNull();
  });
});

describe('admin subscriptions: a failed load clears the rows AND the total', () => {
  const S = { id: 'sub-1', company_id: 'x-1', company_name: 'D2 Acme Ltd', plan_id: 'p1', plan_name: 'Starter', plan_code: 'starter', status: 'active',
    billing_cycle: 'monthly', current_period_start: null, current_period_end: null, discount_percent: 0, monthly_amount_cents: 100, created_at: '2026-01-01T00:00:00Z' };
  const flow = async (second: () => Response) => {
    let loads = 0;
    vi.mocked(apiFetch).mockImplementation(async (url: unknown) => {
      if (String(url).includes('/plans')) return ok([]);
      return ++loads === 1 ? ok({ items: [S], total: 1, page: 1, limit: 25 }) : second();
    });
    render(<SubscriptionsPage />);
    await screen.findByText('D2 Acme Ltd');
    fireEvent.change(screen.getByPlaceholderText('Search company...'), { target: { value: 'zzz' } });
  };
  it('empty 500', async () => {
    await flow(empty500);
    expect(await screen.findByText('Could not load subscriptions - try again')).toBeTruthy();
    expect(screen.queryByText('D2 Acme Ltd')).toBeNull();
    expect(screen.getByText('0 total')).toBeTruthy();
    noRaw();
  });
  it('400: the server message', async () => {
    await flow(bad400);
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(screen.getByText('0 total')).toBeTruthy();
  });
});

describe('trial balance: the cost-centre reference load is checked', () => {
  it('a refused cost-centre list is logged (not swallowed) and the page still loads', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (u.includes('cost-centres')) return bad400();
      return ok({ items: [] });
    });
    render(<TrialBalancePage />);
    await waitFor(() => expect(warn).toHaveBeenCalledWith('Failed to load cost centres', expect.objectContaining({ err: expect.objectContaining({ message: MSG }) }), 'trial-balance'));
  });
});
