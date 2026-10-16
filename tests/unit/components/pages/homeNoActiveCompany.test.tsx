/**
 * /home must never spin forever.
 *
 * Incident 2026-10-16: the session's company had been soft-deleted, so
 * CompanyContext settled with `activeCompany = null`. HomePage's `load()`
 * returns early without an active company, so its own `loading` stayed true,
 * and the guard `companiesLoading || (loading && !data)` kept the spinner on
 * screen with nothing ever arriving. The page now distinguishes "still
 * loading companies" from "finished, and there is no company".
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, screen, waitFor, fireEvent } from '@testing-library/react';

const push = vi.fn();
vi.mock('next/router', () => ({ useRouter: () => ({ push }) }));

vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

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
  assertOk: vi.fn(async () => undefined),
  apiErrorMessage: (_e: unknown, fallback: string) => fallback,
}));

import HomePage from '../../../../pages/home';

beforeEach(() => {
  vi.clearAllMocks();
  companyState = { activeCompany: null, companies: [], loading: false };
  apiFetch.mockResolvedValue(new Response(JSON.stringify({ data: null }), { status: 200 }));
});

afterEach(cleanup);

function spinner(container: HTMLElement) {
  return container.querySelector('.animate-spin');
}

describe('/home with no active company', () => {
  it('still spins while CompanyContext is loading', () => {
    companyState = { activeCompany: null, companies: [], loading: true };
    const { container } = render(<HomePage />);
    expect(spinner(container)).not.toBeNull();
  });

  it('stops spinning and offers the user\'s other companies once loading has finished', async () => {
    companyState = {
      activeCompany: null,
      loading: false,
      companies: [
        { companyId: 'c1', companyName: 'Alpha Trading', role: 'owner', isDefault: false },
        { companyId: 'c2', companyName: 'Beta Holdings', role: 'admin', isDefault: false },
      ],
    };
    const { container } = render(<HomePage />);

    await waitFor(() => expect(spinner(container)).toBeNull());
    expect(screen.getByText('No company selected')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Beta Holdings' }));
    expect(switchCompany).toHaveBeenCalledWith('c2');
  });

  it('points a user with no companies at onboarding instead of spinning', async () => {
    const { container } = render(<HomePage />);

    await waitFor(() => expect(spinner(container)).toBeNull());
    expect(screen.getByText('No company selected')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Set up a company' }));
    expect(push).toHaveBeenCalledWith('/onboarding');
  });

  it('never calls /api/home without an active company', async () => {
    const { container } = render(<HomePage />);
    await waitFor(() => expect(spinner(container)).toBeNull());
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
