import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  INVOICE_FORM_ROUTES, LIST_FILTER_ROUTES, MIGRATION_WIZARD_ROUTES, isSessionProblem, isWarm, shouldWarm, warmUntilHealthy, type Answer, type WarmRoute,
} from '../../e2e/golden-paths/helpers/warmDevRoutes';

const HTML = 'text/html; charset=utf-8';
const JSON_CT = 'application/json';
const api: WarmRoute = { kind: 'api', path: '/api/x' };
const pg: WarmRoute = { kind: 'page', path: '/p' };
const a = (status: number, contentType = JSON_CT): Answer => ({ status, contentType });

describe('isWarm', () => {
  it('a page is warm only at 200', () => {
    expect(isWarm(pg, a(200, HTML))).toBe(true);
    for (const s of [404, 500, 302]) expect(isWarm(pg, a(s, HTML)), String(s)).toBe(false);
  });

  it("an API is warm on its own JSON answers (2xx, 4xx, the app's 500), never on HTML", () => {
    for (const s of [200, 400, 404, 405, 422]) expect(isWarm(api, a(s)), String(s)).toBe(true);
    expect(isWarm(api, a(500, JSON_CT))).toBe(true); // the app's own error envelope: the route compiled and ran
    expect(isWarm(api, a(500, HTML))).toBe(false); // z2's failure: next dev's error page
    expect(isWarm(api, a(502, HTML))).toBe(false);
    expect(isWarm(api, a(404, HTML))).toBe(false); // next's not-found page: a listed route that no longer exists is not 'warm'
    expect(isWarm(api, a(200, HTML))).toBe(false);
  });

  it('never accepts a redirect, 401 or 403: that is the session, not a compile', () => {
    for (const s of [301, 302, 307, 401, 403]) {
      expect(isWarm(api, a(s)), String(s)).toBe(false);
      expect(isSessionProblem(a(s)), String(s)).toBe(true);
    }
    expect(isSessionProblem(a(500, HTML))).toBe(false);
  });

  it('a route that names its status needs exactly that one', () => {
    const exact: WarmRoute = { kind: 'api', path: '/api/uc', status: 200 };
    expect(isWarm(exact, a(200))).toBe(true);
    expect(isWarm(exact, a(405))).toBe(false);
    expect(isWarm(exact, a(500, HTML))).toBe(false);
  });
});

describe('warmUntilHealthy', () => {
  const fast = { intervalMs: 1, perRouteMs: 500 };

  it('waits through the dev server\'s HTML 500 and a reset socket, then moves on', async () => {
    const answers: Array<Answer | Error> = [a(500, HTML), new Error('apiRequestContext.get: read ECONNRESET\nCall log: ...'), a(200)];
    let calls = 0;
    await warmUntilHealthy([api], async () => { const x = answers[calls++]!; if (x instanceof Error) throw x; return x; }, fast);
    expect(calls).toBe(3);
  });

  it('requests the routes one at a time, in order, and nothing else', async () => {
    const seen: string[] = [];
    let inFlight = 0; let overlap = false;
    await warmUntilHealthy([pg, api, { kind: 'page', path: '/q' }], async (p) => {
      if (++inFlight > 1) overlap = true;
      seen.push(p); await new Promise((r) => setTimeout(r, 2)); inFlight--;
      return p.startsWith('/api') ? a(200) : a(200, HTML);
    }, fast);
    expect(seen).toEqual(['/p', '/api/x', '/q']);
    expect(overlap).toBe(false);
  });

  it('fails naming the route and its last answer when it never turns healthy, instead of letting the spec meet the compile', async () => {
    await expect(warmUntilHealthy([pg, api], async (p) => (p === '/p' ? a(200, HTML) : a(500, HTML)), fast))
      .rejects.toThrow(/warm-up \/api\/x was not healthy within 500 ms: last answer 500 text\/html/);
  });

  it('one shared deadline: a stuck route names itself before the hook\'s own timeout, and a request is never given more than the budget left', async () => {
    const timeouts: number[] = [];
    const t0 = Date.now();
    await expect(warmUntilHealthy([pg, api, { kind: 'api', path: '/api/late' }], async (p, timeoutMs) => {
      timeouts.push(timeoutMs);
      return p === '/p' ? a(200, HTML) : a(500, HTML);
    }, { intervalMs: 5, perRouteMs: 60_000, totalMs: 300 })).rejects.toThrow(/warm-up \/api\/x was not healthy within 300 ms/);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(Math.max(...timeouts)).toBeLessThanOrEqual(60_000);
    expect(timeouts.slice(1).every((t) => t <= 1_000)).toBe(true); // the budget left, floored at 1 s
  });

  it('fails at once on a session problem, without waiting out the deadline', async () => {
    const t0 = Date.now();
    await expect(warmUntilHealthy([api], async () => a(401), { intervalMs: 1, perRouteMs: 60_000 })).rejects.toThrow(/golden session is not valid/);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
});

describe('shouldWarm', () => {
  it('is off in the production verify (a production build has nothing to compile), on everywhere else', () => {
    expect(shouldWarm({ GOLDEN_SKIP_A11Y: '1' })).toBe(false);
    expect(shouldWarm({})).toBe(true);
    expect(shouldWarm({ GOLDEN_SKIP_A11Y: '0' })).toBe(true);
  });
});

describe('the routes each spec warms', () => {
  const dir = path.resolve(__dirname, '../../e2e/golden-paths');
  const apiPaths = (file: string): string[] => [...new Set([...readFileSync(path.join(dir, file), 'utf8').matchAll(/\/api\/accounting\/[a-zA-Z0-9/_-]+/g)].map((m) => m[0]))];
  const covered = (routes: readonly WarmRoute[]): Set<string> => new Set(routes.map((r) => r.path.split('?')[0]!));

  // TEXT GUARD (drift): a route the spec starts calling and the warm-up list does not know is a cold compile mid-test again.
  it('m-migration-wizard: every /api/accounting route the spec and its sandbox helper name is warmed', () => {
    const named = [...apiPaths('m-migration-wizard.spec.ts'), ...apiPaths('_migrationSandbox.ts')];
    expect(named.length).toBeGreaterThan(10);
    expect(named.filter((p) => !covered(MIGRATION_WIZARD_ROUTES).has(p))).toEqual([]);
    expect(covered(MIGRATION_WIZARD_ROUTES).has('/api/accounting/customers')).toBe(true); // Api.fixtureCustomer(), named in _api.ts
  });
  it('z2-invoice-autosave-send: every /api/accounting route the spec and its fixture name is warmed', () => {
    const named = [...apiPaths('z2-invoice-autosave-send.spec.ts'), ...apiPaths('_invoiceAutosaveFixture.ts')];
    expect(named.filter((p) => !covered(INVOICE_FORM_ROUTES).has(p))).toEqual([]);
  });
  it('the user-companies lookup that failed in #1835 must answer 200 before the spec starts', () => {
    for (const routes of [MIGRATION_WIZARD_ROUTES, INVOICE_FORM_ROUTES]) {
      expect(routes.find((r) => r.path === '/api/accounting/companies?action=user-companies')).toMatchObject({ kind: 'api', status: 200 });
    }
  });
  it('u-list-filter-dates: every API route its watchers name, and every page it opens, is warmed', () => {
    const src = readFileSync(path.join(dir, 'u-list-filter-dates.spec.ts'), 'utf8');
    const watched = [...src.matchAll(/watch\(page, \/(.+)\/\);/g)].map((m) => m[1]!.replace(/\\/g, '').replace(/\?$/, ''));
    expect(watched).toHaveLength(3);
    const pages = [...src.matchAll(/path: '(\/accounting\/[^']+)'/g)].map((m) => m[1]!);
    expect(pages).toHaveLength(3);
    const c = covered(LIST_FILTER_ROUTES);
    expect([...watched, ...pages].filter((p) => !c.has(p))).toEqual([]);
  });
  // TEXT GUARD: the call must be inside a top-level test.beforeAll (not a comment, not a test body).
  it('every spec calls warmDevRoutes with its list from a test.beforeAll', () => {
    const calls: Array<[string, string]> = [
      ['m-migration-wizard.spec.ts', 'MIGRATION_WIZARD_ROUTES'], ['z2-invoice-autosave-send.spec.ts', 'INVOICE_FORM_ROUTES'], ['u-list-filter-dates.spec.ts', 'LIST_FILTER_ROUTES'],
    ];
    for (const [file, list] of calls) {
      expect(readFileSync(path.join(dir, file), 'utf8'), file).toMatch(new RegExp(`^test\\.beforeAll\\(async \\(\\) => \\{ await warmDevRoutes\\(${list}\\); \\}\\);`, 'm'));
    }
  });
});
