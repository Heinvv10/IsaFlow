/**
 * D2 round 3: switchCompany now throws when /api/auth/switch-company is refused. Every caller must show
 * the message and NOT carry on as if switched (no navigation, offer kept) instead of an unhandled rejection.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

const h = vi.hoisted(() => ({
  switchCompany: vi.fn(), push: vi.fn(),
  notify: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/utils/toast', () => ({ notify: h.notify }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: h.push, replace: vi.fn() }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => ({
  useCompany: () => ({
    activeCompany: { id: 'co-1', name: 'First Co' }, loading: false, switchCompany: h.switchCompany,
    companies: [{ companyId: 'co-1', companyName: 'First Co' }, { companyId: 'co-2', companyName: 'Demo Company', role: 'owner' }],
  }),
}));

import { apiFetch } from '@/lib/apiFetch';
import { CompanySwitcher } from '@/components/layout/CompanySwitcher';
import { DemoCompanyCTA } from '@/components/onboarding/DemoCompanyCTA';
import BureauDashboardPage from '../../../pages/bureau/index';

useApiJsonOverMock();
configure({ asyncUtilTimeout: 4000 });
const MSG = 'D2 server says no: you no longer have access to that company';
beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); h.switchCompany.mockRejectedValue(new Error(MSG)); });
afterEach(() => { cleanup(); vi.mocked(apiFetch).mockReset(); });

describe('a refused company switch', () => {
  it('CompanySwitcher shows the message and raises no unhandled rejection', async () => {
    render(<CompanySwitcher />);
    fireEvent.click(screen.getByRole('button', { name: /first co/i }));
    fireEvent.click(await screen.findByText('Demo Company'));
    await waitFor(() => expect(h.notify.error).toHaveBeenCalledWith(MSG));
  });

  it('DemoCompanyCTA shows the message and keeps the offer (does not dismiss)', async () => {
    render(<DemoCompanyCTA />);
    fireEvent.click(await screen.findByRole('button', { name: 'Try Demo' }));
    await waitFor(() => expect(h.notify.error).toHaveBeenCalledWith(MSG));
    expect(localStorage.getItem('isaflow_demo_cta_dismissed')).toBeNull();
    expect(screen.getByRole('button', { name: 'Try Demo' })).toBeTruthy();
  });

  it('DemoCompanyCTA: a good switch dismisses the offer', async () => {
    h.switchCompany.mockResolvedValue(undefined);
    render(<DemoCompanyCTA />);
    fireEvent.click(await screen.findByRole('button', { name: 'Try Demo' }));
    await waitFor(() => expect(localStorage.getItem('isaflow_demo_cta_dismissed')).toBe('1'));
    expect(h.notify.error).not.toHaveBeenCalled();
  });

  it('bureau dashboard: opening an item of another company shows the message and does not navigate; a good switch navigates', async () => {
    const item = { bureauId: 'b1', bureauName: 'B', companyId: 'co-9', companyName: 'C', task: 'Reconcile D2 bank', detail: 'd', dueAt: null, href: '/x', severity: 'info' };
    vi.mocked(apiFetch).mockImplementation(async () => new Response(JSON.stringify({ success: true, data: {
      bureaus: [{ id: 'b1', name: 'Okapi', ownerUserId: 'u1', role: 'owner' }], workItems: [item],
      stats: { overdue: 0, dueSoon: 0, info: 1, total: 1 }, companyCount: 1 } }), { status: 200 }));
    render(<BureauDashboardPage />);
    fireEvent.click(await screen.findByText('Reconcile D2 bank'));
    await waitFor(() => expect(h.notify.error).toHaveBeenCalledWith(MSG));
    expect(h.push).not.toHaveBeenCalled();
    h.switchCompany.mockResolvedValue(undefined);
    fireEvent.click(screen.getByText('Reconcile D2 bank'));
    await waitFor(() => expect(h.push).toHaveBeenCalledWith('/x'));
  });
});
