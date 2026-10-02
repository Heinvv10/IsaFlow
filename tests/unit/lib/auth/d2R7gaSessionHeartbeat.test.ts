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
