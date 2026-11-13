/**
 * The dashboard (/accounting, home for every direct client) must never spin forever.
 *
 * Incident 2026-10-16: the session's company had been soft-deleted, so
 * CompanyContext settled with `activeCompany = null` and the old /home page
 * kept its spinner on screen with nothing ever arriving. Ported from
 * homeNoActiveCompany when /home became a redirect to /accounting: the page
 * distinguishes "still loading companies" from "finished, and there is no company".
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, screen, waitFor, fireEvent } from '@testing-library/react';

const push = vi.fn();
const replace = vi.fn();
vi.mock('next/router', () => ({ useRouter: () => ({ push, replace, query: {}, isReady: true }) }));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1', role: 'owner' }, loading: false }) }));

const switchCompany = vi.fn(async () => {});
let companyState: {
  activeCompany: { id: string; name: string } | null;
  companies: Array<{ companyId: string; companyName: string; role: string; isDefault: boolean }>;
  loading: boolean;
};
vi.mock('@/contexts/CompanyContext', () => ({
  useCompany: () => ({ ...companyState, companyRole: 'owner', switchCompany }),
}));

const apiFetch = vi.fn();
vi.mock('@/lib/apiFetch', () => ({
  apiFetch: (...a: unknown[]) => apiFetch(...a),
  apiJson: async (url: string) => { await apiFetch(url); return { ok: true, data: null }; },
  assertOk: vi.fn(async () => undefined),
  apiErrorMessage: (_e: unknown, fallback: string) => fallback,
  ApiEnvelopeError: class extends Error {},
}));

import AccountingPage from '../../../../pages/accounting/index';

beforeEach(() => {
  vi.clearAllMocks();
  companyState = { activeCompany: null, companies: [], loading: false };
  apiFetch.mockResolvedValue(new Response(JSON.stringify({ data: null }), { status: 200 }));
});

afterEach(cleanup);

const skeleton = () => screen.queryByTestId('dashboard-skeleton');
const calls = (needle: string) => apiFetch.mock.calls.filter(([u]) => String(u).includes(needle)).length;

describe('the dashboard with no active company', () => {
  it('shows the skeleton while CompanyContext is loading', () => {
    companyState = { activeCompany: null, companies: [], loading: true };
    render(<AccountingPage />);
    expect(skeleton()).not.toBeNull();
    expect(screen.queryByText('No company selected')).toBeNull();
  });

  it('stops loading and offers the user\'s other companies once loading has finished', async () => {
    companyState = {
      activeCompany: null,
      loading: false,
      companies: [
        { companyId: 'c1', companyName: 'Alpha Trading', role: 'owner', isDefault: false },
        { companyId: 'c2', companyName: 'Beta Holdings', role: 'admin', isDefault: false },
      ],
    };
    render(<AccountingPage />);

    expect(await screen.findByText('No company selected')).toBeTruthy();
    expect(skeleton()).toBeNull();
    expect(screen.getByText(/We couldn't open the company this session was pointed at\. It may have been removed\./)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Beta Holdings' }));
    expect(switchCompany).toHaveBeenCalledWith('c2');
  });

  it('points a user with no companies at onboarding instead of spinning', async () => {
    render(<AccountingPage />);

    expect(await screen.findByText('No company selected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Set up a company' }));
    expect(push).toHaveBeenCalledWith('/onboarding');
  });

  it('never requests the dashboard figures without an active company', async () => {
    render(<AccountingPage />);
    await screen.findByText('No company selected');
    await waitFor(() => expect(skeleton()).toBeNull());
    expect(calls('kpi-dashboard')).toBe(0);
    expect(calls('dashboard/attention')).toBe(0);
  });
});
