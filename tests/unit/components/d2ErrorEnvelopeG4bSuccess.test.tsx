/**
 * D2 success paths for the admin billing action sites in d2ErrorEnvelopeG4b: a 200 success envelope completes the
 * action (modal closed, list reloaded with the server's new data).
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockedApiFetchModule, useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, isReady: true, push: vi.fn() }) }));

import { apiFetch } from '@/lib/apiFetch';
import InvoicesPage from '../../../pages/admin/billing/invoices';
import PlansPage from '../../../pages/admin/billing/plans';
import SubscriptionsPage from '../../../pages/admin/billing/subscriptions';

void mockedApiFetchModule;
useApiJsonOverMock();

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const success = (data: unknown) => json({ success: true, data });

type Router = (path: string, method: string) => Response | null;
function script(route: Router) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url, init) =>
    route(String(url).split('?')[0]!, init?.method ?? 'GET') ?? success({}));
}

const INVOICE = { id: 'inv-1', invoice_number: 'INV-1', company_id: 'c1', company_name: 'Acme', status: 'draft',
  subtotal_cents: 100, tax_cents: 15, total_cents: 115, currency: 'ZAR', due_date: null, paid_at: null,
  payment_method: null, created_at: '2026-01-01T00:00:00Z' };
const PLAN = { id: 'plan-1', code: 'starter', name: 'Starter', description: '', monthly_price_cents: 100,
  annual_price_cents: 1000, currency: 'ZAR', features: {}, limits: {}, is_active: true, display_order: 1, created_at: '2026-01-01T00:00:00Z' };


const calls = (p: string, m: string) => vi.mocked(apiFetch).mock.calls.filter(([u, i]) =>
  String(u).split('?')[0] === p && ((i as RequestInit | undefined)?.method ?? 'GET') === m).length;
const NEW_INV = { ...INVOICE, id: 'inv-2', invoice_number: 'INV-NEW-8841', company_name: 'Freshly Raised Co' };

afterEach(() => { cleanup(); });

describe('admin billing actions complete on a success envelope', () => {
  it('success: invoices send completes', async () => {
    script((p, m) => (p === '/api/admin/billing/invoices' && m === 'GET' ? success({ items: [INVOICE], total: 1, page: 1, limit: 25 }) : null));
    render(<InvoicesPage />);
    const send = await screen.findByTitle('Send');
    // The page loads twice on mount (the page effect, then the 300 ms search debounce). Let both land before the
    // click, so the count below is the post-send reload alone rather than a race with the debounce on a slow runner.
    await waitFor(() => expect(calls('/api/admin/billing/invoices', 'GET')).toBe(2), { timeout: 5000 });
    fireEvent.click(send);
    await waitFor(() => expect(calls('/api/admin/billing/invoices/inv-1/send', 'POST')).toBe(1));
    await waitFor(() => expect(calls('/api/admin/billing/invoices', 'GET')).toBe(3));
    expect(screen.queryByText(/failed/i)).toBeNull();
  });

  it('success: invoices create completes', async () => {
    let created = false;
    script((p, m) => {
      if (p === '/api/admin/billing/invoices' && m === 'GET') return success({ items: created ? [NEW_INV] : [], total: created ? 1 : 0, page: 1, limit: 25 });
      if (p === '/api/admin/billing/invoices' && m === 'POST') { created = true; return success({ id: 'inv-2' }); }
      return null;
    });
    const { container } = render(<InvoicesPage />);
    fireEvent.click(await screen.findByRole('button', { name: /create invoice/i }));
    const inputs = container.querySelectorAll('[role="dialog"] input');
    fireEvent.change(inputs[0]!, { target: { value: 'c9' } });
    fireEvent.change(inputs[1]!, { target: { value: '100' } });
    fireEvent.change(inputs[3]!, { target: { value: '115' } });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));
    expect(await screen.findByText('INV-NEW-8841')).toBeTruthy();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('success: plans create completes', async () => {
    let created = false;
    script((p, m) => {
      if (p === '/api/admin/billing/plans' && m === 'GET') return success(created ? [{ ...PLAN, id: 'plan-2', name: 'Freshly Minted Plan' }] : []);
      if (p === '/api/admin/billing/plans' && m === 'POST') { created = true; return success({ id: 'plan-2' }); }
      return null;
    });
    const { container } = render(<PlansPage />);
    fireEvent.click(await screen.findByRole('button', { name: /add plan/i }));
    fireEvent.click(screen.getByRole('button', { name: /create plan/i }));
    expect(await screen.findByText('Freshly Minted Plan')).toBeTruthy();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('success: plans archive completes', async () => {
    let archived = false;
    vi.stubGlobal('confirm', () => true);
    script((p, m) => {
      if (p === '/api/admin/billing/plans' && m === 'GET') return success(archived ? [] : [PLAN]);
      if (p === '/api/admin/billing/plans/plan-1' && m === 'DELETE') { archived = true; return success({}); }
      return null;
    });
    render(<PlansPage />);
    fireEvent.click(await screen.findByTitle('Archive'));
    expect(await screen.findByText('No plans found')).toBeTruthy();
    expect(screen.queryByText('Starter')).toBeNull();
  });

  it('success: subscriptions create completes', async () => {
    let created = false;
    const sub = { id: 's2', company_id: 'c9', company_name: 'Freshly Subscribed Co', plan_id: 'plan-1', plan_name: 'Starter', plan_code: 'starter',
      status: 'active', billing_cycle: 'monthly', current_period_start: null, current_period_end: null, cancel_at_period_end: false,
      discount_percent: 0, monthly_amount_cents: 100, created_at: '2026-01-01T00:00:00Z' };
    script((p, m) => {
      if (p === '/api/admin/billing/subscriptions' && m === 'GET') return success({ items: created ? [sub] : [], total: created ? 1 : 0, page: 1, limit: 25 });
      if (p === '/api/admin/billing/plans') return success([{ id: 'plan-1', name: 'Starter', code: 'starter' }]);
      if (p === '/api/admin/companies') return success({ items: [{ id: 'c9', name: 'Company Nine' }], total: 1 });
      if (p === '/api/admin/companies/c9') return success({ id: 'c9', name: 'Company Nine' });
      if (p === '/api/admin/billing/subscriptions' && m === 'POST') { created = true; return success({ id: 's2' }); }
      return null;
    });
    const { container } = render(<SubscriptionsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /add subscription/i }));
    await screen.findByRole('option', { name: /starter/i });
    const dialog = container.querySelector('[role="dialog"]')!;
    fireEvent.change(dialog.querySelector('input[type="text"]')!, { target: { value: 'Nine' } });
    fireEvent.click(await screen.findByRole('option', { name: 'Company Nine' }));
    await screen.findByText('Company Nine');
    fireEvent.change(dialog.querySelectorAll('select')[0]!, { target: { value: 'plan-1' } });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));
    expect(await screen.findByText('Freshly Subscribed Co')).toBeTruthy();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
});
