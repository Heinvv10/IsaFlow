/**
 * D2 (admin audit, waitlist, company billing tab): the server's refusal message from the real error
 * envelope `{ success:false, error:{ code, message } }` reaches the user. These sites read
 * `json.message` (always undefined) and showed the generic fallback.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockedApiFetchModule, useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn(), replace: vi.fn(), pathname: '/' }) }));
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import { apiFetch } from '@/lib/apiFetch';
import AuditPage from '../../../pages/admin/audit';
import WaitlistPage from '../../../pages/admin/waitlist/index';
import { CompanyBillingTab } from '@/components/admin/companies/CompanyBillingTab';

void mockedApiFetchModule;
useApiJsonOverMock();

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const refuse = (msg: string, status = 403) => json({ success: false, error: { code: 'FORBIDDEN', message: msg } }, status);
const pathOf = (u: unknown) => String(u).split('?')[0];
const ROW = {
  id: 'w-1', name: 'Ann', email: 'ann@example.test', signup_type: 'direct', company_name: 'Acme', practice_name: null,
  phone: null, annual_turnover_cents: null, created_at: '2026-10-01T00:00:00Z', promoted_at: null, promoted_company_id: null,
};

afterEach(() => { cleanup(); });

describe('admin pages show the refusal message of the real envelope', () => {
  it('audit log: load refused', async () => {
    vi.mocked(apiFetch).mockReset().mockImplementation(async (url) =>
      pathOf(url) === '/api/admin/audit' ? refuse('D2 server says no: audit') : json({ success: true, data: { items: [] } }));
    render(<AuditPage />);
    expect(await screen.findByText(/D2 server says no: audit/)).toBeTruthy();
  });

  it('waitlist: load refused', async () => {
    vi.mocked(apiFetch).mockReset().mockImplementation(async () => refuse('D2 server says no: waitlist'));
    render(<WaitlistPage />);
    expect(await screen.findByText(/D2 server says no: waitlist/)).toBeTruthy();
  });

  it('waitlist: promote refused', async () => {
    vi.mocked(apiFetch).mockReset().mockImplementation(async (url) =>
      String(url).includes('/promote') ? refuse('D2 server says no: promote', 409)
        : json({ success: true, data: { items: [ROW], total: 1, page: 1, limit: 20, total_pages: 1 } }));
    render(<WaitlistPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Promote/ }));
    const form = (await screen.findByText('Promote waitlist signup')).closest('div')!.parentElement!.querySelector('form')!;
    fireEvent.submit(form);
    expect(await screen.findByText(/D2 server says no: promote/)).toBeTruthy();
  });

  it('company billing tab: subscription load refused', async () => {
    vi.mocked(apiFetch).mockReset().mockImplementation(async (url) =>
      pathOf(url) === '/api/admin/billing/subscriptions' ? refuse('D2 server says no: subscription')
        : json({ success: true, data: { items: [] } }));
    render(<CompanyBillingTab companyId="co-1" />);
    expect(await screen.findByText(/D2 server says no: subscription/)).toBeTruthy();
  });
});
