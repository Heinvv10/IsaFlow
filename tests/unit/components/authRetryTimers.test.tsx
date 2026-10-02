/**
 * D9 round 3: AuthContext's retry timer. A first /api/auth/me check that hits
 * an outage retries every 5 s. A focus re-check (or Retry) while that timer is
 * pending must replace it, not add a second one; unmounting must cancel it;
 * and concurrent checks join the one already in flight instead of stacking
 * requests. Fake timers; only `fetch` is stubbed.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';

import { AuthProvider, useAuth } from '@/contexts/AuthContext';

const json = (status: number) => new Response('{}', { status, headers: { 'content-type': 'application/json' } });

function outageFetch() {
  return vi.fn(async (url: string) => {
    if (url !== '/api/auth/me') throw new Error(`unexpected fetch ${url}`);
    return json(503);
  });
}

let refreshUser: (() => Promise<void>) | null = null;
function Probe() {
  const auth = useAuth();
  refreshUser = auth.refreshUser;
  return <span data-testid="checking">{String(auth.authChecking)}</span>;
}

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); refreshUser = null; });

describe('AuthContext retry timer during an outage', () => {
  it('a focus re-check while a retry is pending replaces the timer: one request per interval, not two', async () => {
    vi.useFakeTimers();
    const fetch = outageFetch();
    vi.stubGlobal('fetch', fetch);
    render(<AuthProvider><Probe /></AuthProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(fetch).toHaveBeenCalledTimes(1); // t=0, retry pending for t=5 s
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    await act(async () => { window.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(0); });
    expect(fetch).toHaveBeenCalledTimes(2); // t=2 s, its retry is for t=7 s
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    expect(fetch).toHaveBeenCalledTimes(2); // t=6 s: the t=5 s timer was cleared, not left to fire
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(fetch).toHaveBeenCalledTimes(3); // t=7 s
  });

  it('unmounting with a retry pending makes no further request', async () => {
    vi.useFakeTimers();
    const fetch = outageFetch();
    vi.stubGlobal('fetch', fetch);
    const view = render(<AuthProvider><Probe /></AuthProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(fetch).toHaveBeenCalledTimes(1);
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('a /api/auth/me that never answers is abandoned after 10 s: the check ends and the next retry is armed', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn()
      .mockImplementationOnce((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        // An unbounded request would hang for good; the test then fails on the assertions below.
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }))
      .mockImplementation(async () => json(503));
    vi.stubGlobal('fetch', fetch);
    render(<AuthProvider><Probe /></AuthProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByTestId('checking').textContent).toBe('true');
    await act(async () => { await vi.advanceTimersByTimeAsync(9_999); });
    expect(screen.getByTestId('checking').textContent).toBe('true'); // still waiting at 9.999 s
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByTestId('checking').textContent).toBe('false'); // abandoned at 10 s: Retry is usable again
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(fetch).toHaveBeenCalledTimes(2); // the 5 s retry was armed by the abandoned check
  });

  it('checks asked for while one is in flight join it instead of sending another request', async () => {
    let release!: (r: Response) => void;
    const fetch = vi.fn()
      .mockImplementationOnce(async () => json(503))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));
    vi.stubGlobal('fetch', fetch);
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await act(async () => {
      const first = refreshUser!();
      const second = refreshUser!();
      window.dispatchEvent(new Event('focus'));
      expect(fetch).toHaveBeenCalledTimes(2);
      release(json(503));
      await Promise.all([first, second]);
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
