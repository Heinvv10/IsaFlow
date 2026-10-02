// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'public/isa-track.js'), 'utf8');
const fetchMock = vi.fn();

function load() {
  document.head.innerHTML = '';
  const s = document.createElement('script');
  s.setAttribute('data-t', 'trk1');
  document.head.appendChild(s);
  Object.defineProperty(document, 'currentScript', { value: s, configurable: true });
  (window as unknown as Record<string, unknown>).__isaTrack = undefined;
  // eslint-disable-next-line no-new-func
  new Function(SRC).call(window);
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  Object.defineProperty(navigator, 'sendBeacon', { value: undefined, configurable: true });
  Object.defineProperty(navigator, 'doNotTrack', { value: '0', configurable: true });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('isa-track fetch transport', () => {
  it.each([[500], [403], [200]])('a %i answer is consumed without an unhandled rejection', async (status) => {
    const body = status === 200 ? '{}' : '';
    fetchMock.mockResolvedValue(new Response(body, { status }));
    load();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', keepalive: true, credentials: 'omit' });
  });

  it('a rejected fetch never throws into the host page', async () => {
    fetchMock.mockRejectedValue(new TypeError('blocked'));
    expect(() => load()).not.toThrow();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
  });
});
