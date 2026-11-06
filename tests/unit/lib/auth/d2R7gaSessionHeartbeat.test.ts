// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { log } from '@/lib/logger';
import { startSessionHeartbeat } from '@/lib/auth/sessionHeartbeat';

const fetchMock = vi.fn();
let stop: () => void;
const tickIdle = async () => {
  localStorage.setItem('isaflow_last_activity_at', String(Date.now() - 3 * 60 * 60 * 1000));
  await vi.advanceTimersByTimeAsync(50 * 60 * 1000);
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(log.warn).mockReset();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  Object.defineProperty(window, 'location', { value: { href: '/accounting', pathname: '/accounting' }, writable: true, configurable: true });
  stop = startSessionHeartbeat({ idleTimeoutMinutes: 60 });
});
afterEach(() => { stop(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('sessionHeartbeat idle bounce: server logout is best effort but never silent', () => {
  it('a refused logout is logged and the redirect still happens', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 500 }));
    await tickIdle();
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/logout', expect.objectContaining({ method: 'POST' }));
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('refused'), expect.objectContaining({ status: 500 }), 'auth');
    expect(window.location.href).toBe('/login?reason=idle-timeout');
  });

  it('a transport failure is logged and the redirect still happens', async () => {
    fetchMock.mockRejectedValue(new TypeError('network down'));
    await tickIdle();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('failed'), expect.anything(), 'auth');
    expect(window.location.href).toBe('/login?reason=idle-timeout');
  });

  it('a good logout logs nothing and redirects', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    await tickIdle();
    expect(log.warn).not.toHaveBeenCalled();
    expect(window.location.href).toBe('/login?reason=idle-timeout');
  });
});

describe('sessionHeartbeat background refresh', () => {
  const refreshes = () => fetchMock.mock.calls.filter(([url]) => url === '/api/auth/refresh').length;
  const minutes = (n: number) => vi.advanceTimersByTimeAsync(n * 60 * 1000);
  const keepActive = () => localStorage.setItem('isaflow_last_activity_at', String(Date.now()));

  beforeEach(() => {
    stop();
    localStorage.removeItem('isaflow_last_refresh_at');
    keepActive();
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    stop = startSessionHeartbeat({ idleTimeoutMinutes: 480 });
  });

  it('does not refresh early', async () => {
    await minutes(45);
    expect(refreshes()).toBe(0);
  });

  it('refreshes once 50 minutes have passed, then not again for another 50', async () => {
    await minutes(50);
    expect(refreshes()).toBe(1);
    await minutes(45);
    expect(refreshes()).toBe(1);
    await minutes(5);
    expect(refreshes()).toBe(2);
  });

  it('a page change, which remounts AppLayout, does not restart the wait', async () => {
    await minutes(40);
    stop();
    stop = startSessionHeartbeat({ idleTimeoutMinutes: 480 });
    await minutes(10);
    expect(refreshes()).toBe(1);
  });

  it('a refresh time in the future does not switch the refresh off', async () => {
    localStorage.setItem('isaflow_last_refresh_at', String(Date.now() + 3 * 60 * 60 * 1000));
    await minutes(55);
    expect(refreshes()).toBe(1);
  });

  it('an activity time in the future does not switch the idle bounce off', async () => {
    stop();
    stop = startSessionHeartbeat({ idleTimeoutMinutes: 60 });
    localStorage.setItem('isaflow_last_activity_at', String(Date.now() + 3 * 60 * 60 * 1000));
    await minutes(70);
    expect(window.location.href).toBe('/login?reason=idle-timeout');
  });

  it('a tab refreshes on its own: no other tab has to be alive or visible', async () => {
    const otherTab = startSessionHeartbeat({ idleTimeoutMinutes: 480 });
    otherTab();
    await minutes(50);
    expect(refreshes()).toBe(1);
  });

  it('a hidden tab does not tick', async () => {
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    await minutes(50);
    expect(refreshes()).toBe(0);
    hidden.mockRestore();
  });

  it('a second open tab finds the refresh already done', async () => {
    const otherTab = startSessionHeartbeat({ idleTimeoutMinutes: 480 });
    await minutes(50);
    expect(refreshes()).toBe(1);
    otherTab();
  });

  it('starts when localStorage throws', () => {
    stop();
    const denied = () => { throw new DOMException('denied', 'SecurityError'); };
    vi.stubGlobal('localStorage', { getItem: denied, setItem: denied, removeItem: denied });
    expect(() => { stop = startSessionHeartbeat({ idleTimeoutMinutes: 480 }); }).not.toThrow();
  });

  it('an idle bounce fires within a tick of the limit and logs out once', async () => {
    stop();
    stop = startSessionHeartbeat({ idleTimeoutMinutes: 60 });
    await minutes(70);
    const logouts = fetchMock.mock.calls.filter(([url]) => url === '/api/auth/logout').length;
    expect(logouts).toBe(1);
    expect(window.location.href).toBe('/login?reason=idle-timeout');
  });
});
