/**
 * D9 (client half): an auth-provider outage must not send the user to /login.
 *
 * The server now answers an outage 503 + Retry-After and keeps the cookies.
 * The browser must treat that as "try again", never as "signed out": apiFetch
 * must not bounce when the refresh itself is unavailable, AuthContext must not
 * forget the user (AdminLayout redirects on a null user), and the onboarding
 * gate must not redirect on a 503 from /api/auth/me. Only `fetch` is stubbed;
 * apiFetch and AuthContext run for real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';

const { replace } = vi.hoisted(() => ({ replace: vi.fn(async () => true) }));
vi.mock('next/router', () => ({ useRouter: () => ({ replace, push: vi.fn(), pathname: '/admin', query: {}, isReady: true }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/components/admin/AdminNav', () => ({ AdminNav: () => null }));

import { apiFetch } from '@/lib/apiFetch';
import { AuthProvider, useAuth } from '@/contexts/AuthContext';
import { AdminLayout } from '@/components/admin/AdminLayout';
import OnboardingWizard from '../../../pages/onboarding/index';

const json = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ME = { success: true, data: { user: { id: 'u-1', email: 'admin@example.test', role: 'super_admin' } } };

let location: { pathname: string; href: string };
const originalLocation = window.location;
beforeEach(() => {
  location = { pathname: '/accounting/customers', href: 'http://localhost/accounting/customers' };
  Object.defineProperty(window, 'location', { configurable: true, value: location });
  replace.mockClear();
});
afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  // apiFetch shares one refresh promise and resets it on the next macrotask.
  await new Promise((r) => setTimeout(r, 0));
  vi.unstubAllGlobals();
  Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
});

/** Answers by URL; each value is a queue, the last entry repeats. */
function routeFetch(routes: Record<string, Array<Response | Error>>) {
  return vi.fn(async (url: string) => {
    const queue = routes[url.split('?')[0]!];
    if (!queue) throw new Error(`unexpected fetch ${url}`);
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    if (next instanceof Error) throw next;
    return next.clone();
  });
}

describe('apiFetch', () => {
  it('passes a 503 from an authenticated route straight back: no refresh, no redirect', async () => {
    const fetch = routeFetch({ '/api/accounting/customers': [json(503, { success: false })] });
    vi.stubGlobal('fetch', fetch);
    const res = await apiFetch('/api/accounting/customers');
    expect(res.status).toBe(503);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(location.href).toBe('http://localhost/accounting/customers');
  });

  it.each([
    ['the refresh answers 503', json(503, { success: false })],
    ['the refresh is rate-limited (429)', json(429, { success: false })],
    ['the refresh cannot be reached', new TypeError('Failed to fetch')],
  ])('a 401 whose refresh is unavailable (%s) stays on the page and answers 503', async (_l, refreshAnswer) => {
    vi.stubGlobal('fetch', routeFetch({
      '/api/accounting/customers': [json(401, { success: false })],
      '/api/auth/refresh': [refreshAnswer],
    }));
    const res = await apiFetch('/api/accounting/customers');
    expect(location.href).toBe('http://localhost/accounting/customers');
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
    await expect(res.json()).resolves.toMatchObject({ success: false, error: { code: 'AUTH_UNAVAILABLE' } });
  });

  it('a 401 whose refresh is refused (401) still sends the user to /login', async () => {
    vi.stubGlobal('fetch', routeFetch({
      '/api/accounting/customers': [json(401, { success: false })],
      '/api/auth/refresh': [json(401, { success: false })],
    }));
    const res = await apiFetch('/api/accounting/customers');
    expect(res.status).toBe(401);
    expect(location.href).toBe('/login?reason=session-expired');
  });
});

function Probe() {
  const { user, loading } = useAuth();
  return <span data-testid="state">{loading ? 'loading' : (user?.id ?? 'none')}</span>;
}

describe('AuthContext', () => {
  it('a first /api/auth/me that answers 503 keeps the session pending, then retries into the user', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetch = routeFetch({ '/api/auth/me': [json(503), json(200, ME)] });
    vi.stubGlobal('fetch', fetch);
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId('state').textContent).toBe('loading');
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('u-1'));
  });

  it.each([['503', json(503)], ['a network error', new TypeError('Failed to fetch')]])(
    'a later re-check that fails with %s keeps the signed-in user', async (_l, failure) => {
      const fetch = routeFetch({ '/api/auth/me': [json(200, ME), failure] });
      vi.stubGlobal('fetch', fetch);
      render(<AuthProvider><Probe /></AuthProvider>);
      await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('u-1'));
      await act(async () => { window.dispatchEvent(new Event('focus')); });
      // The end state is the failed re-check having settled; only then can "unchanged" be asserted.
      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
      await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
      expect(screen.getByTestId('state').textContent).toBe('u-1');
    });

  it('a failed re-check of a known session is not polled harder than the focus/interval re-checks', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetch = routeFetch({ '/api/auth/me': [json(200, ME), json(503)] });
    vi.stubGlobal('fetch', fetch);
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('u-1'));
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('state').textContent).toBe('u-1');
  });

  it('a re-check answered 401 does sign the user out', async () => {
    vi.stubGlobal('fetch', routeFetch({ '/api/auth/me': [json(200, ME), json(401)] }));
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('u-1'));
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('none'));
  });
});

describe('AdminLayout', () => {
  it('does not redirect a super-admin to /login while /api/auth/me answers 503', async () => {
    const fetch = routeFetch({ '/api/auth/me': [json(503)] });
    vi.stubGlobal('fetch', fetch);
    render(<AuthProvider><AdminLayout title="Users"><p>console</p></AdminLayout></AuthProvider>);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(replace).not.toHaveBeenCalled();
  });

  it('still redirects when /api/auth/me answers 401', async () => {
    vi.stubGlobal('fetch', routeFetch({ '/api/auth/me': [json(401)] }));
    render(<AuthProvider><AdminLayout title="Users"><p>console</p></AdminLayout></AuthProvider>);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/login'));
  });
});

describe('Onboarding gate', () => {
  it.each([['503', json(503)], ['a network error', new TypeError('Failed to fetch')]])(
    '/api/auth/me failing with %s shows the escape link instead of redirecting to /login', async (_l, failure) => {
      vi.stubGlobal('fetch', routeFetch({ '/api/auth/me': [failure] }));
      render(<OnboardingWizard />);
      await screen.findByText(/We could not load onboarding setup/);
      expect(replace).not.toHaveBeenCalled();
    });

  it('/api/auth/me answered 403 still redirects to /login', async () => {
    vi.stubGlobal('fetch', routeFetch({ '/api/auth/me': [json(403)] }));
    render(<OnboardingWizard />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/login'));
  });
});
