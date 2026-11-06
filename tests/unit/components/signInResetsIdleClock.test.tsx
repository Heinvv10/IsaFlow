// The heartbeat signs out on a stored activity time past the limit, so a real sign-in must reset that time or a user
// signing back in next morning is thrown straight out. Nothing else may reset it: not a failed sign-in, and above all
// not a browser that /login renewed from its refresh cookie, or the idle limit is gone.
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

configure({ asyncUtilTimeout: 4000 });
const h = vi.hoisted(() => ({ assign: vi.fn(), replace: vi.fn(), push: vi.fn(async () => true), query: {} as Record<string, string>, isAuthenticated: false }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: h.query, push: h.push, replace: vi.fn(), pathname: '/login' }) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('next/image', () => ({ default: () => <span /> }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ error: null, clearError: vi.fn(), isAuthenticated: h.isAuthenticated, loading: false }) }));
vi.mock('@/components/auth/LoginBrandPanel', () => ({ LoginBrandPanel: () => <div /> }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import LoginPage from '../../../pages/login';
import AcceptInvitePage from '../../../pages/accept-invite';

const KEY = 'isaflow_last_activity_at';
const YESTERDAY = String(Date.now() - 24 * 60 * 60 * 1000);
const fetchMock = vi.fn();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const refused = (code: string, status = 401) => json({ success: false, error: { code, message: 'No' } }, status);
const isReset = () => Number(localStorage.getItem(KEY)) > Number(YESTERDAY) + 60_000;

beforeEach(() => {
  fetchMock.mockReset(); h.assign.mockReset(); h.replace.mockReset(); h.push.mockClear();
  h.query = {}; h.isAuthenticated = false;
  sessionStorage.clear();
  localStorage.setItem(KEY, YESTERDAY);
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('location', { hostname: 'app.isaflow.co.za', search: '', href: '', assign: h.assign, replace: h.replace });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

function submitPassword() {
  const { container } = render(<LoginPage />);
  fireEvent.change(container.querySelector('input[name="email"]')!, { target: { value: 'qa@example.test' } });
  fireEvent.change(container.querySelector('input[name="password"]')!, { target: { value: 'pw-123456' } });
  fireEvent.submit(container.querySelector('form')!);
}

describe('/login and the idle clock', () => {
  it('a password sign-in resets it before leaving the page', async () => {
    fetchMock.mockImplementation(async () => json({ success: true, data: {} }));
    submitPassword();
    await waitFor(() => expect(h.assign).toHaveBeenCalled());
    expect(isReset()).toBe(true);
  });

  it('a refused password leaves it alone', async () => {
    fetchMock.mockImplementation(async () => refused('INVALID_CREDENTIALS'));
    submitPassword();
    await screen.findByText('No');
    expect(localStorage.getItem(KEY)).toBe(YESTERDAY);
  });

  it('only the code completes a two-factor sign-in', async () => {
    fetchMock.mockImplementation(async (url: string) => (String(url).includes('2fa-challenge')
      ? json({ success: true, data: {} })
      : json({ success: true, data: { requires_2fa: true, factor_id: 'f1' } })));
    submitPassword();
    const input = await screen.findByPlaceholderText('000000');
    expect(localStorage.getItem(KEY)).toBe(YESTERDAY);
    fireEvent.change(input, { target: { value: '123456' } });
    await waitFor(() => expect((input.closest('form')!.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(h.assign).toHaveBeenCalled());
    expect(isReset()).toBe(true);
  });

  it('a browser renewed from its refresh cookie does not reset it, on the way through or signed out', () => {
    fetchMock.mockImplementation(async () => json({ success: true, data: {} }));
    render(<LoginPage />);
    cleanup();
    h.isAuthenticated = true;
    h.query = { returnTo: '/accounting/afs/doc-1' };
    render(<LoginPage />);
    expect(h.replace).toHaveBeenCalledWith('/accounting/afs/doc-1');
    expect(localStorage.getItem(KEY)).toBe(YESTERDAY);
  });
});

describe('/accept-invite and the idle clock', () => {
  const invite = json({ success: true, data: { email: 'qa@example.test', role: 'user', company_name: 'Acme' } });
  async function submitInvite(accept: () => Response) {
    h.query = { token: 't1' };
    fetchMock.mockImplementation(async (url: string) => (String(url).endsWith('/accept') ? accept() : invite.clone()));
    const { container } = render(<AcceptInvitePage />);
    await waitFor(() => expect(container.querySelector('input[name="password"]')).toBeTruthy());
    fireEvent.change(container.querySelector('input[name="password"]')!, { target: { value: 'long-enough-pw' } });
    fireEvent.submit(container.querySelector('form')!);
  }

  it('an accepted invitation signs in, so it resets the clock', async () => {
    await submitInvite(() => json({ success: true, data: {} }));
    await waitFor(() => expect(h.push).toHaveBeenCalledWith('/accounting'));
    expect(isReset()).toBe(true);
  });

  it('a refused invitation leaves it alone', async () => {
    await submitInvite(() => refused('SIGN_IN_REQUIRED', 409));
    await screen.findByRole('alert');
    expect(localStorage.getItem(KEY)).toBe(YESTERDAY);
  });
});
