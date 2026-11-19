// @vitest-environment happy-dom
/**
 * public/isa-track.js sends nothing from the share page or the employee portal (wave 6 SS, review #1576 delta), the
 * two scenarios of the breaker's bypass probe: the script already loaded on a staff page, then a client-side route
 * into the portal (pageviews and custom events); and a page under the portal that Next answers with its 404.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'public/isa-track.js'), 'utf8');
const fetchMock = vi.fn();
const tick = () => new Promise((r) => setTimeout(r, 20));
const sentPaths = () => fetchMock.mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body)).p as string);

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

// Each load wraps history.pushState/replaceState again: put the originals back so earlier loads stop reporting.
const original = { push: window.history.pushState, replace: window.history.replaceState };
beforeEach(() => {
  window.history.pushState = original.push;
  window.history.replaceState = original.replace;
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  Object.defineProperty(navigator, 'sendBeacon', { value: undefined, configurable: true });
  Object.defineProperty(navigator, 'doNotTrack', { value: '0', configurable: true });
});
afterEach(() => {
  window.history.pushState = original.push;
  window.history.replaceState = original.replace;
  window.history.replaceState(null, '', '/');
  vi.unstubAllGlobals();
});

describe('isa-track on untracked paths', () => {
  it('loaded on a staff page, then routed client-side into the portal: nothing from the portal', async () => {
    window.history.replaceState(null, '', '/login');
    load();
    await tick();
    expect(sentPaths()).toEqual(['/login']);
    for (const path of ['/employee-portal/login', '/employee-portal', '/share/abc']) {
      window.history.pushState(null, '', path);
      await tick();
      (window as unknown as { isaTrack: { event(n: string): void } }).isaTrack.event('click');
      await tick();
    }
    window.history.pushState(null, '', '/payroll/employees');
    await tick();
    expect(sentPaths()).toEqual(['/login', '/payroll/employees']);
  });

  it.each(['/employee-portal/nope', '/employee-portal', '/share', '/share/token123'])('loaded on %s (a 404 or the page itself): nothing', async (path) => {
    window.history.replaceState(null, '', path);
    load();
    await tick();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the segment boundary: /employee-portals and /shared-with-me are tracked', async () => {
    window.history.replaceState(null, '', '/employee-portals');
    load();
    await tick();
    window.history.pushState(null, '', '/shared-with-me');
    await tick();
    expect(sentPaths()).toEqual(['/employee-portals', '/shared-with-me']);
  });
});
