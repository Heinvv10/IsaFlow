// /login?invite=<t> used to land on the dashboard after sign-in, so "Sign In to Accept" never accepted anything.
// The invitation is now the default return, and it beats the onboarding redirect (an invitee is joining a company).
import { cleanup, configure, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

configure({ asyncUtilTimeout: 4000 });
const h = vi.hoisted(() => ({ assign: vi.fn(), query: {} as Record<string, string> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: h.query, push: vi.fn(), replace: vi.fn(), pathname: '/login' }) }));
vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a> }));
vi.mock('next/image', () => ({ default: () => <span /> }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ error: null, clearError: vi.fn(), isAuthenticated: false, loading: false }) }));
vi.mock('@/lib/auth/clearTenantClientState', () => ({ clearTenantClientState: vi.fn() }));
vi.mock('@/components/auth/LoginBrandPanel', () => ({ LoginBrandPanel: () => <div /> }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import LoginPage from '../../../pages/login';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  h.assign.mockReset();
  vi.stubGlobal('fetch', vi.fn(async (url: string) =>
    String(url).includes('/api/auth/landing')
      ? json({ success: true, data: { defaultTarget: '/onboarding' } })
      : json({ success: true, data: {} })));
  vi.stubGlobal('location', { hostname: 'app.isaflow.co.za', search: '', href: '', assign: h.assign });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('/login?invite=<token>', () => {
  it('returns to the invitation after sign-in, even when the landing resolver says onboarding', async () => {
    h.query = { invite: 'settings-invite-token' };
    const { container } = render(<LoginPage />);
    fireEvent.change(container.querySelector('input[name="email"]')!, { target: { value: 'qa@example.test' } });
    fireEvent.change(container.querySelector('input[name="password"]')!, { target: { value: 'pw-123456' } });
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(h.assign).toHaveBeenCalledWith('/invite/settings-invite-token'));
  });

  it('"Create one" goes to the acceptance page, not the new-company signup', () => {
    h.query = { invite: 'settings-invite-token' };
    const { getByText } = render(<LoginPage />);
    expect(getByText('Create one').closest('a')!.getAttribute('href')).toBe('/accept-invite?token=settings-invite-token');
  });

  it('without an invitation, onboarding still wins', async () => {
    h.query = {};
    const { container } = render(<LoginPage />);
    fireEvent.change(container.querySelector('input[name="email"]')!, { target: { value: 'qa@example.test' } });
    fireEvent.change(container.querySelector('input[name="password"]')!, { target: { value: 'pw-123456' } });
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(h.assign).toHaveBeenCalledWith('/onboarding'));
  });
});
