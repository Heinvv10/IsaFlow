import { describe, it, expect } from 'vitest';
import { waitForRoute, type ProbePage } from '../../e2e/helpers/routeProbe';

/** A page whose request.get answers from `script` in order, then repeats the last entry. */
function fake(script: Array<number | Error>): { page: ProbePage; calls: () => number } {
  let n = 0;
  return {
    calls: () => n,
    page: {
      request: {
        get: async () => {
          const next = script[Math.min(n++, script.length - 1)] as number | Error;
          if (next instanceof Error) throw next;
          return { status: () => next };
        },
      },
      waitForTimeout: async () => undefined,
    },
  };
}

describe('waitForRoute', () => {
  it('returns on the first success', async () => {
    const f = fake([200]);
    await waitForRoute(f.page, '/a#frag', Date.now() + 5_000);
    expect(f.calls()).toBe(1);
  });

  it.each([404, 410])('%i is terminal: one request, a clear message', async (status) => {
    const f = fake([status]);
    await expect(waitForRoute(f.page, '/nope', Date.now() + 5_000)).rejects.toThrow(`/nope answered ${status}`);
    expect(f.calls()).toBe(1);
  });

  it.each([408, 429, 500, 502, 503])('%i is the server being busy: polled until it clears', async (status) => {
    const f = fake([status, status, 200]);
    await waitForRoute(f.page, '/busy', Date.now() + 5_000);
    expect(f.calls()).toBe(3);
  });

  it('a reset is polled too', async () => {
    const f = fake([new Error('net::ERR_EMPTY_RESPONSE'), 200]);
    await waitForRoute(f.page, '/x', Date.now() + 5_000);
    expect(f.calls()).toBe(2);
  });

  it('gives up at the deadline and names the budget that applied, not the default', async () => {
    const f = fake([503]);
    await expect(waitForRoute(f.page, '/slow', Date.now() + 40)).rejects.toThrow(/within \d{1,2} ms \(last: HTTP 503\)/);
  });
});
