/**
 * D2 (admin billing action sites): invoice send / create, plan create / archive, subscription create.
 * The server's refusal message from the real error envelope is what the user sees, not the fallback.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockedApiFetchModule, useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import { apiFetch } from '@/lib/apiFetch';
import InvoicesPage from '../../../pages/admin/billing/invoices';
import PlansPage from '../../../pages/admin/billing/plans';
import SubscriptionsPage from '../../../pages/admin/billing/subscriptions';

void mockedApiFetchModule;
useApiJsonOverMock();

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const success = (data: unknown) => json({ success: true, data });
const refuse = (msg: string) => json({ success: false, error: { code: 'CONFLICT', message: msg } }, 409);

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

afterEach(() => { cleanup(); });

describe('admin billing actions show the server message', () => {
  it('invoices: send action refused', async () => {
    const msg = 'D2 server says no: invoice cannot be sent, customer has no billing email';
    script((p, m) => {
      if (p === '/api/admin/billing/invoices' && m === 'GET') return success({ items: [INVOICE], total: 1, page: 1, limit: 25 });
      if (p.endsWith('/send')) return refuse(msg);
      return null;
    });
    render(<InvoicesPage />);
    fireEvent.click(await screen.findByTitle('Send'));
    expect(await screen.findByText(msg)).toBeTruthy();
  });

  it('invoices: create refused', async () => {
    const msg = 'D2 server says no: company c9 is suspended, no invoices can be raised';
    script((p, m) => {
      if (p === '/api/admin/billing/invoices' && m === 'GET') return success({ items: [], total: 0, page: 1, limit: 25 });
      if (p === '/api/admin/billing/invoices' && m === 'POST') return refuse(msg);
      return null;
    });
    const { container } = render(<InvoicesPage />);
    fireEvent.click(await screen.findByRole('button', { name: /create invoice/i }));
    const inputs = container.querySelectorAll('[role="dialog"] input');
    fireEvent.change(inputs[0]!, { target: { value: 'c9' } });
    fireEvent.change(inputs[1]!, { target: { value: '100' } });
    fireEvent.change(inputs[3]!, { target: { value: '115' } });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));
    expect(await screen.findByText(msg)).toBeTruthy();
  });

  it('plans: create refused', async () => {
    const msg = 'D2 server says no: plan code starter already exists';
    script((p, m) => {
      if (p === '/api/admin/billing/plans' && m === 'GET') return success([]);
      if (p === '/api/admin/billing/plans' && m === 'POST') return refuse(msg);
      return null;
    });
    render(<PlansPage />);
    fireEvent.click(await screen.findByRole('button', { name: /add plan/i }));
    fireEvent.click(screen.getByRole('button', { name: /create plan/i }));
    expect(await screen.findByText(msg)).toBeTruthy();
  });

  it('plans: archive refused', async () => {
    const msg = 'D2 server says no: plan has live subscriptions on the annual cycle';
    vi.stubGlobal('confirm', () => true);
    script((p, m) => {
      if (p === '/api/admin/billing/plans' && m === 'GET') return success([PLAN]);
      if (p === '/api/admin/billing/plans/plan-1' && m === 'DELETE') return refuse(msg);
      return null;
    });
    render(<PlansPage />);
    fireEvent.click(await screen.findByTitle('Archive'));
    expect(await screen.findByText(msg)).toBeTruthy();
  });

  it('subscriptions: create refused', async () => {
    const msg = 'D2 server says no: company c9 already has an active subscription';
    script((p, m) => {
      if (p === '/api/admin/billing/subscriptions' && m === 'GET') return success({ items: [], total: 0, page: 1, limit: 25 });
      if (p === '/api/admin/billing/plans') return success([{ id: 'plan-1', name: 'Starter', code: 'starter' }]);
      if (p === '/api/admin/billing/subscriptions' && m === 'POST') return refuse(msg);
      return null;
    });
    const { container } = render(<SubscriptionsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /add subscription/i }));
    await screen.findByRole('option', { name: /starter/i });
    const dialog = container.querySelector('[role="dialog"]')!;
    fireEvent.change(dialog.querySelector('input[type="text"]')!, { target: { value: 'c9' } });
    fireEvent.change(dialog.querySelectorAll('select')[0]!, { target: { value: 'plan-1' } });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));
    expect(await screen.findByText(msg)).toBeTruthy();
  });
});
