/**
 * The access cookie lives an hour and the refresh cookie 30 days, so a 401 from
 * /api/auth/me usually means "renew", not "signed out". AuthProvider has to try
 * the refresh before it forgets the user. Only `fetch` is stubbed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';

import { AuthProvider, useAuth } from '@/contexts/AuthContext';
import { AUTH_CHECK_TIMEOUT_MS } from '@/contexts/useSessionCheck';

const json = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ME = { success: true, data: { user: { id: 'u-1', email: 'user@example.test', role: 'accountant' } } };

function routeFetch(routes: Record<string, Array<Response | Error | 'hang'>>) {
  return vi.fn((url: string, init?: RequestInit) => {
    const queue = routes[url.split('?')[0]!];
    if (!queue) return Promise.reject(new Error(`unexpected fetch ${url}`));
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    if (next === 'hang') {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    }
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next.clone());
  });
}

function Probe() {
  const { user, loading, authUnavailable } = useAuth();
  return (
    <>
      <span data-testid="state">{loading ? 'loading' : (user?.id ?? 'none')}</span>
      <span data-testid="unavailable">{String(authUnavailable)}</span>
    </>
  );
}
const state = () => screen.getByTestId('state').textContent;
const urls = (fetch: ReturnType<typeof routeFetch>) => fetch.mock.calls.map(([url]) => url);

afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  await new Promise((r) => setTimeout(r, 0)); // apiFetch resets its shared refresh on the next macrotask
  vi.unstubAllGlobals();
});

describe('AuthProvider when /api/auth/me answers 401', () => {
  it('renews the session and keeps the user', async () => {
    const fetch = routeFetch({ '/api/auth/me': [json(401), json(200, ME)], '/api/auth/refresh': [json(200)] });
    vi.stubGlobal('fetch', fetch);
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(state()).toBe('u-1'));
    expect(urls(fetch)).toEqual(['/api/auth/me', '/api/auth/refresh', '/api/auth/me']);
  });

  it('forgets the user when the refresh is refused', async () => {
    const fetch = routeFetch({ '/api/auth/me': [json(401)], '/api/auth/refresh': [json(401)] });
    vi.stubGlobal('fetch', fetch);
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(state()).toBe('none'));
    expect(urls(fetch)).toEqual(['/api/auth/me', '/api/auth/refresh']);
  });

  it.each([
    ['answers 503', json(503)],
    ['cannot be reached', new TypeError('Failed to fetch')],
  ])('treats a refresh that %s as an outage, not a sign-out', async (_l, answer) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal('fetch', routeFetch({ '/api/auth/me': [json(401), json(200, ME)], '/api/auth/refresh': [answer, json(200)] }));
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('unavailable').textContent).toBe('true'));
    expect(state()).toBe('loading');
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    await waitFor(() => expect(state()).toBe('u-1'));
  });

  it('abandons a refresh that never answers as an outage', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal('fetch', routeFetch({ '/api/auth/me': [json(401)], '/api/auth/refresh': ['hang'] }));
    render(<AuthProvider><Probe /></AuthProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTH_CHECK_TIMEOUT_MS + 1); });
    await waitFor(() => expect(screen.getByTestId('unavailable').textContent).toBe('true'));
    expect(state()).toBe('loading');
  });

  it('forgets the user when the renewed session still answers 401', async () => {
    const fetch = routeFetch({ '/api/auth/me': [json(401), json(401)], '/api/auth/refresh': [json(200)] });
    vi.stubGlobal('fetch', fetch);
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(state()).toBe('none'));
    expect(urls(fetch)).toEqual(['/api/auth/me', '/api/auth/refresh', '/api/auth/me']);
  });
});

it('a 403 from /api/auth/me is a verdict: no refresh is attempted', async () => {
  const fetch = routeFetch({ '/api/auth/me': [json(403)] });
  vi.stubGlobal('fetch', fetch);
  render(<AuthProvider><Probe /></AuthProvider>);
  await waitFor(() => expect(state()).toBe('none'));
  expect(urls(fetch)).toEqual(['/api/auth/me']);
});

it('a refresh that hung does not pin the next check to it', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.stubGlobal('fetch', routeFetch({
    '/api/auth/me': [json(401), json(401), json(200, ME)],
    '/api/auth/refresh': ['hang', json(200)],
  }));
  render(<AuthProvider><Probe /></AuthProvider>);
  await act(async () => { await vi.advanceTimersByTimeAsync(AUTH_CHECK_TIMEOUT_MS + 1); });
  await waitFor(() => expect(screen.getByTestId('unavailable').textContent).toBe('true'));
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  await waitFor(() => expect(state()).toBe('u-1'));
});
