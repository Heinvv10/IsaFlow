/**
 * Sentry/Bugsink gets errors only: no tracing (any tracesSampleRate, even 0, turns it on), no metrics (on by default), no client reports
 * and no sessions. Each config is loaded with Sentry switched on against a recording @sentry/nextjs, and its init options are checked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  init: vi.fn(),
  setTag: vi.fn(),
  httpIntegration: vi.fn((opts: unknown) => ({ name: 'Http', opts })),
}));
vi.mock('@sentry/nextjs', () => m);

type Options = Record<string, unknown> & { integrations?: unknown };
const initOptions = (): Options => m.init.mock.calls.at(-1)![0] as Options;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv('SENTRY_ENABLED', 'true');
  vi.stubEnv('SENTRY_DSN', 'https://k@bugsink.test/1');
  vi.stubEnv('NEXT_PUBLIC_SENTRY_ENABLED', 'true');
  vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', 'https://k@bugsink.test/1');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function expectErrorsOnly(o: Options): void {
  expect('tracesSampleRate' in o).toBe(false);
  expect('tracesSampler' in o).toBe(false);
  expect(o.enableMetrics).toBe(false);
  expect(o.sendClientReports).toBe(false);
}

describe('Sentry sends errors only', () => {
  it('server: no tracing, metrics or client reports, and requests are not tracked as sessions', async () => {
    await import('../../../sentry.server.config');
    const o = initOptions();
    expectErrorsOnly(o);
    expect(m.httpIntegration).toHaveBeenCalledWith({ trackIncomingRequestsAsSessions: false });
    expect(o.integrations).toEqual([{ name: 'Http', opts: { trackIncomingRequestsAsSessions: false } }]);
  });

  it('edge: no tracing, metrics or client reports', async () => {
    await import('../../../sentry.edge.config');
    expectErrorsOnly(initOptions());
  });

  it('browser: no tracing, metrics or client reports, and the BrowserSession integration is dropped', async () => {
    vi.stubGlobal('window', {});
    await import('../../../sentry.client.config');
    const o = initOptions();
    expectErrorsOnly(o);
    const pick = o.integrations as (d: Array<{ name: string }>) => Array<{ name: string }>;
    expect(pick([{ name: 'BrowserSession' }, { name: 'Dedupe' }, { name: 'GlobalHandlers' }]).map((i) => i.name)).toEqual(['Dedupe', 'GlobalHandlers']);
  });
});
