// @vitest-environment happy-dom
// Hein, 2026-11-06: someone with "Keep me signed in" ticked survives the default 8 hours on coming back, so no
// password every morning. A limit the company tightened below 8 hours always holds, unticked is always held to the
// limit, and an open visible tab left idle still signs out.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { startSessionHeartbeat } from '@/lib/auth/sessionHeartbeat';

const KEY = 'isaflow_last_activity_at';
const IDLE_URL = '/login?reason=idle-timeout';
const HERE = '/accounting';
const DEFAULT_LIMIT = 480;
const TIGHTENED = 479;
const fetchMock = vi.fn();
let stop: () => void = () => undefined;

const awayFor = (minutes: number) => localStorage.setItem(KEY, String(Date.now() - minutes * 60 * 1000));
const settle = () => vi.advanceTimersByTimeAsync(0);
const logouts = () => fetchMock.mock.calls.filter(([url]) => url === '/api/auth/logout').length;
const setHidden = (hidden: boolean) => vi.spyOn(document, 'hidden', 'get').mockReturnValue(hidden);
const start = (idleTimeoutMinutes: number, rememberMe?: boolean) => {
  stop = startSessionHeartbeat({ idleTimeoutMinutes, rememberMe });
};
const setCookie = (value: string) => vi.spyOn(document, 'cookie', 'get').mockReturnValue(value);

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  Object.defineProperty(window, 'location', { value: { href: HERE, pathname: HERE }, writable: true, configurable: true });
});
afterEach(() => { stop(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('coming back after the idle limit', () => {
  it('ticked, default limit, next morning: stays signed in, and the clock restarts', async () => {
    awayFor(15 * 60);
    start(DEFAULT_LIMIT, true);
    await settle();
    expect(window.location.href).toBe(HERE);
    expect(logouts()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(window.location.href).toBe(HERE); // the first tick must not read the stale time either
  });

  it('ticked, a limit the company raised: stays signed in', async () => {
    awayFor(15 * 60);
    start(DEFAULT_LIMIT + 60, true);
    await settle();
    expect(window.location.href).toBe(HERE);
  });

  it('ticked, a limit tightened by one minute: signs out', async () => {
    awayFor(15 * 60);
    start(TIGHTENED, true);
    await settle();
    expect(logouts()).toBe(1);
    expect(window.location.href).toBe(IDLE_URL);
  });

  it.each([['unticked', false], ['unknown', undefined]])('%s, default limit: signs out', async (_label, rememberMe) => {
    awayFor(15 * 60);
    start(DEFAULT_LIMIT, rememberMe);
    await settle();
    expect(window.location.href).toBe(IDLE_URL);
  });

  it('ticked, default limit: a tab coming back stays signed in', async () => {
    start(DEFAULT_LIMIT, true);
    awayFor(15 * 60);
    setHidden(false);
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(window.location.href).toBe(HERE);
  });

  it('tightened limit: a tab coming back signs out', async () => {
    start(TIGHTENED, true);
    awayFor(15 * 60);
    setHidden(false);
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(window.location.href).toBe(IDLE_URL);
  });

  it('ticked, default limit: the first mouse move stays signed in', async () => {
    start(DEFAULT_LIMIT, true);
    awayFor(15 * 60);
    document.dispatchEvent(new Event('mousemove'));
    await settle();
    expect(window.location.href).toBe(HERE);
  });

  it('tightened limit: the first mouse move signs out', async () => {
    start(TIGHTENED, true);
    awayFor(15 * 60);
    document.dispatchEvent(new Event('mousemove'));
    await settle();
    expect(window.location.href).toBe(IDLE_URL);
  });
});

describe('an open visible tab left idle', () => {
  it('signs out at the default limit even with the box ticked', async () => {
    start(DEFAULT_LIMIT, true);
    awayFor(DEFAULT_LIMIT + 1);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(logouts()).toBe(1);
    expect(window.location.href).toBe(IDLE_URL);
  });
});

describe('a Login-as session', () => {
  it('is not ended at start by a stored time from an earlier visit, whatever the limit', async () => {
    setCookie('isaflow_csrf=x; is_impersonating=1');
    awayFor(15 * 60);
    start(30);
    await settle();
    expect(logouts()).toBe(0);
    expect(window.location.href).toBe(HERE);
  });

  it('a similar cookie name or value does not count', async () => {
    setCookie('not_is_impersonating=1; is_impersonating=0');
    awayFor(15 * 60);
    start(30);
    await settle();
    expect(window.location.href).toBe(IDLE_URL);
  });
});
