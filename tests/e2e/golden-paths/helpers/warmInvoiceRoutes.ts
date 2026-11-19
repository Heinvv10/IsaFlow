import { expect, request as pwRequest, test } from '@playwright/test';

// The routes Create touches: the create API, the saved invoice's page, and the two reads that page makes at once.
const NIL_ID = '00000000-0000-0000-0000-000000000000';
const WARM_PAGE = `/accounting/customer-invoices/${NIL_ID}`;
const WARM_APIS = [
  '/api/accounting/customer-invoices-create', // GET answers 405: enough to compile the route, creates nothing
  `/api/accounting/customer-invoices-detail?id=${NIL_ID}`,
  `/api/accounting/customer-invoices-adjacent?id=${NIL_ID}`,
];

/**
 * `next dev` compiles a route on its first request and then tells every open page to do a full reload (see
 * u-list-filter-dates.spec.ts). Create is the first request for the saved invoice's page, so on a fresh dev server
 * (every hosted chunk piece) the reload landed on /new while the push to the invoice was still in flight: the invoice
 * was created, the page reloaded onto an empty /new, and waitForURL timed out. Requesting those routes once before any
 * page is open makes the compile happen with no page to reload. Call it from a spec's test.beforeAll.
 */
export async function warmInvoiceRoutes(): Promise<void> {
  test.setTimeout(240_000); // four cold compiles: longer than the config's 90 s test timeout
  const { baseURL, storageState } = test.info().project.use;
  if (!storageState) throw new Error('invoice warm-up needs the golden session (use.storageState); refusing to warm up unauthenticated');
  const ctx = await pwRequest.newContext({ baseURL, storageState });
  try {
    // No redirects: a stale session would 302 to /login and must fail here, not be mistaken for a warm route.
    const page = await ctx.get(WARM_PAGE, { timeout: 120_000, maxRedirects: 0 });
    expect(page.status(), `warm-up ${WARM_PAGE} (a 3xx means the session is not valid)`).toBe(200);
    for (const path of WARM_APIS) {
      const res = await ctx.get(path, { timeout: 120_000, maxRedirects: 0 });
      expect(res.status(), `warm-up ${path}: the route must answer, even with a refusal`).toBeLessThan(500);
    }
  } finally {
    await ctx.dispose();
  }
}
