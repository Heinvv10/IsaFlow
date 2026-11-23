import { request as pwRequest, test } from '@playwright/test';

/**
 * `next dev` compiles a route on its first request. A spec whose first touch of a route lands mid-flow met that compile
 * under load: an HTML 500 page from the dev server (z2-invoice-autosave-send, #1835), a reset socket
 * (m-migration-wizard, #1784), a request that never came (u-list-filter-dates, #1834). Each failed once and passed
 * on the rerun; all three sat in the first piece of their chunk, on a freshly started dev server. This compiles the
 * routes a spec uses before its first test, with no page open, and waits for a healthy answer from each.
 *
 * Call it from the spec's own test.beforeAll, not once per run: the dev server drops a built route that nobody has
 * asked for in 60 s (next's onDemandEntries.maxInactiveAge), so a warm-up in global setup would be gone by the time
 * a spec that starts minutes later needs it.
 */
export interface WarmRoute {
  /** A page, which must answer 200, or an API route, which may answer any app status (a 400 or 405 means it compiled). */
  kind: 'page' | 'api';
  path: string;
  /** Require exactly this status (for routes that must answer the warm-up's own GET with data). */
  status?: number;
}

const NIL_ID = '00000000-0000-0000-0000-000000000000';
const page = (path: string): WarmRoute => ({ kind: 'page', path });
const api = (path: string, status?: number): WarmRoute => ({ kind: 'api', path, status });

/** What m-migration-wizard.spec.ts requests: its two pages and every API route it calls (a GET on a POST-only route answers 405: compiled). */
export const MIGRATION_WIZARD_ROUTES: readonly WarmRoute[] = [
  api('/api/accounting/companies?action=user-companies', 200),
  api('/api/accounting/migration/session'),
  api('/api/accounting/migration-parse'),
  api('/api/accounting/migration/ar-invoices'),
  api('/api/accounting/gl-import-validate'),
  api('/api/accounting/gl-import'),
  api(`/api/accounting/journal-entries-detail?id=${NIL_ID}`),
  api('/api/accounting/journal-entries-action'),
  api(`/api/accounting/customer-invoices-detail?id=${NIL_ID}`),
  api('/api/accounting/fiscal-periods'),
  api('/api/accounting/global-search?q=a'),
  api('/api/accounting/reports-trial-balance'),
  api('/api/accounting/reports-general-ledger'),
  api('/api/accounting/sars/sars-vat201'),
  page('/accounting/migration'),
  page('/accounting/migration/opening-balances'),
];

/** What z2-invoice-autosave-send.spec.ts requests: the sandbox lookup, the invoice pages (new, saved, edit) and the invoice APIs. */
export const INVOICE_FORM_ROUTES: readonly WarmRoute[] = [
  api('/api/accounting/companies?action=user-companies', 200),
  api('/api/accounting/customers?q=zz'),
  api('/api/accounting/customer-invoices-create'),
  api(`/api/accounting/customer-invoices-detail?id=${NIL_ID}`),
  api('/api/accounting/invoice-email'),
  page('/accounting/customer-invoices/new'),
  page(`/accounting/customer-invoices/${NIL_ID}`),
  page(`/accounting/customer-invoices/edit/${NIL_ID}`),
];

/** The list screens u-list-filter-dates.spec.ts types dates into, and the list APIs a filter change calls. */
export const LIST_FILTER_ROUTES: readonly WarmRoute[] = [
  api('/api/accounting/bank-transactions'),
  api('/api/accounting/ar-aging'),
  api('/api/accounting/sars/sars-vat201'),
  page('/accounting/bank-transactions'),
  page('/accounting/ar-aging'),
  page('/accounting/sars/vat201'),
];

export interface Answer { status: number; contentType: string }

/**
 * Is this answer the route compiled and serving? Pages must answer 200. An API route compiled when it answers
 * with anything but the dev server's own HTML error page: its own 400/404/405 is fine (the warm-up sends no
 * credentials-worthy input), a JSON 500 is the app's and not a compile. 401/403 are never fine (the session is
 * not valid), and neither is a redirect.
 */
export function isWarm(route: WarmRoute, a: Answer): boolean {
  if (a.status === 401 || a.status === 403 || (a.status >= 300 && a.status < 400)) return false;
  if (route.status !== undefined) return a.status === route.status;
  if (route.kind === 'page') return a.status === 200;
  return !(a.status >= 500 && a.contentType.includes('html'));
}

/** A session problem retrying cannot fix: say so at once instead of waiting out the deadline. */
export function isSessionProblem(a: Answer): boolean {
  return a.status === 401 || a.status === 403 || (a.status >= 300 && a.status < 400);
}

export interface WarmOptions {
  /** How long one route may take to turn healthy (a cold compile under load took seconds, not minutes). */
  perRouteMs?: number;
  intervalMs?: number;
}

type Getter = (path: string) => Promise<Answer>;

/** Requests every route in order, polling each until it is warm; throws naming the route and its last answer. GET only. */
export async function warmUntilHealthy(routes: readonly WarmRoute[], get: Getter, opts: WarmOptions = {}): Promise<void> {
  const { perRouteMs = 120_000, intervalMs = 1_000 } = opts;
  for (const route of routes) {
    const deadline = Date.now() + perRouteMs;
    let last = 'no answer';
    for (;;) {
      try {
        const a = await get(route.path);
        if (isWarm(route, a)) break;
        last = `${a.status} ${a.contentType}`;
        if (isSessionProblem(a)) throw new Error(`warm-up ${route.path}: ${last} (the golden session is not valid)`);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('warm-up ')) throw err;
        last = err instanceof Error ? err.message.split('\n')[0]! : String(err); // a reset socket while it compiles
      }
      if (Date.now() >= deadline) throw new Error(`warm-up ${route.path} was not healthy after ${perRouteMs} ms: last answer ${last}`);
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

/** Call from test.beforeAll: warms `routes` on the dev server under test with the golden session. */
export async function warmDevRoutes(routes: readonly WarmRoute[], opts: WarmOptions = {}): Promise<void> {
  test.setTimeout(240_000); // the hook, not a test: up to a dozen cold compiles, longer than the config's 90 s timeout
  const { baseURL, storageState } = test.info().project.use;
  if (!storageState) throw new Error('dev-route warm-up needs the golden session (use.storageState); refusing to warm up unauthenticated');
  const ctx = await pwRequest.newContext({ baseURL, storageState });
  try {
    // No redirects: a stale session would 302 to /login and must fail here, not be taken for a warm route.
    await warmUntilHealthy(routes, async (path) => {
      const res = await ctx.get(path, { timeout: 120_000, maxRedirects: 0 });
      return { status: res.status(), contentType: res.headers()['content-type'] ?? '' };
    }, opts);
  } finally {
    await ctx.dispose();
  }
}
