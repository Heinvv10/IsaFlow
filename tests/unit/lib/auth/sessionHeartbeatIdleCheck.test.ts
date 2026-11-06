// @vitest-environment happy-dom
// A browser back after hours on its refresh cookie must not get in by moving the mouse: the idle limit is read
// before input can overwrite the stored time, at start and on wake, and only a real sign-in resets the clock.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { markSignedIn, startSessionHeartbeat } from '@/lib/auth/sessionHeartbeat';

const KEY = 'isaflow_last_activity_at';
const IDLE_URL = '/login?reason=idle-timeout';
const LIMIT_MINUTES = 30;
const fetchMock = vi.fn();
let stop: () => void = () => undefined;

const setLastActivity = (minutesAgo: number) => localStorage.setItem(KEY, String(Date.now() - minutesAgo * 60 * 1000));
const start = () => { stop = startSessionHeartbeat({ idleTimeoutMinutes: LIMIT_MINUTES }); };
const settle = () => vi.advanceTimersByTimeAsync(0);
const logouts = () => fetchMock.mock.calls.filter(([url]) => url === '/api/auth/logout').length;
const setHidden = (hidden: boolean) => vi.spyOn(document, 'hidden', 'get').mockReturnValue(hidden);

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  Object.defineProperty(window, 'location', { value: { href: '/accounting', pathname: '/accounting' }, writable: true, configurable: true });
});
afterEach(() => { stop(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('sessionHeartbeat reads the idle limit before input can overwrite it', () => {
  it('signs out at start when the stored time is past the limit, with no tick and no input', async () => {
    setLastActivity(LIMIT_MINUTES + 1);
    start();
    await settle();
    expect(logouts()).toBe(1);
    expect(window.location.href).toBe(IDLE_URL);
  });

  it('signs out at start in a hidden tab too: nobody else may be there to tick', async () => {
    setHidden(true);
    setLastActivity(LIMIT_MINUTES + 1);
    start();
    await settle();
    expect(window.location.href).toBe(IDLE_URL);
  });

  it('starts quietly inside the limit', async () => {
    setLastActivity(LIMIT_MINUTES - 1);
    start();
    await settle();
    expect(logouts()).toBe(0);
    expect(window.location.href).toBe('/accounting');
  });

  it('starts quietly when no time is stored yet', async () => {
    start();
    await settle();
    expect(logouts()).toBe(0);
  });

  it.each(['mousemove', 'keydown', 'click', 'scroll'])('a %s after the limit passed signs out and does not reset the clock', async (event) => {
    setLastActivity(0);
    start();
    await settle();
    await vi.advanceTimersByTimeAsync(1000);
    setLastActivity(LIMIT_MINUTES + 1); // the machine slept, so no tick ran
    const stale = localStorage.getItem(KEY);
    document.dispatchEvent(new Event(event));
    await settle();
    expect(logouts()).toBe(1);
    expect(window.location.href).toBe(IDLE_URL);
    expect(localStorage.getItem(KEY)).toBe(stale);
  });

  it('input while leaving does not reset the clock, so a failed logout still bounces on the way back', async () => {
    setLastActivity(LIMIT_MINUTES + 1);
    const stale = localStorage.getItem(KEY);
    fetchMock.mockReturnValue(new Promise(() => undefined)); // the logout hangs
    start();
    await vi.advanceTimersByTimeAsync(6000);
    document.dispatchEvent(new Event('mousemove'));
    expect(localStorage.getItem(KEY)).toBe(stale);
    expect(logouts()).toBe(1);
  });

  it('input inside the limit still counts as activity', async () => {
    setLastActivity(LIMIT_MINUTES - 1);
    start();
    await vi.advanceTimersByTimeAsync(6000);
    document.dispatchEvent(new Event('mousemove'));
    expect(Number(localStorage.getItem(KEY))).toBe(Date.now());
    expect(logouts()).toBe(0);
  });

  it('a tab coming back into view past the limit signs out before any input', async () => {
    setLastActivity(0);
    const hidden = setHidden(true);
    start();
    await settle();
    setLastActivity(LIMIT_MINUTES + 1);
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(logouts()).toBe(0); // still hidden
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(logouts()).toBe(1);
    expect(window.location.href).toBe(IDLE_URL);
  });

  it('a stopped heartbeat no longer listens for a tab coming back', async () => {
    setLastActivity(0);
    start();
    stop();
    setLastActivity(LIMIT_MINUTES + 1);
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(logouts()).toBe(0);
  });

  it('a real sign-in resets the clock, so yesterday\'s time does not end the new session', async () => {
    setLastActivity(24 * 60);
    markSignedIn();
    start();
    await settle();
    expect(logouts()).toBe(0);
    expect(window.location.href).toBe('/accounting');
  });

  it('markSignedIn does not throw when storage is blocked', () => {
    const denied = () => { throw new DOMException('denied', 'SecurityError'); };
    vi.stubGlobal('localStorage', { getItem: denied, setItem: denied, removeItem: denied });
    expect(() => markSignedIn()).not.toThrow();
  });
});
