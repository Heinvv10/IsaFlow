/**
 * Golden path (z22): the admin console (admin.isaflow.co.za) loads, read-only.
 *
 * Every page a platform admin uses day to day loads with its heading, its first admin API answers 200, and there
 * is no console error, page error or 5xx response on the way. The companies list sorts by Name both ways and by
 * Created; a company's and a user's detail tabs switch and show their table.
 *
 * Read-only and figure-free, because it runs in the post-deploy verify against production (a red run rolls the
 * deploy back): nothing is clicked that saves, sends, suspends, converts, deletes or exports, no number or name from
 * the data is asserted or printed (a company and a user are picked from the list the page loaded), and every
 * non-GET /api/admin request is aborted and fails the test. That guard covers /api/admin/* only: the app shell's own
 * traffic on the same pages (analytics beacons to /api/track/event, session refresh, announcement reads) is not
 * blocked. System Health is not visited: GET /api/admin/health runs
 * checkAndAlert after commit, which writes the alert state and can send a real email and webhook (unit tests cover
 * it); that GET is aborted too, should any page start calling it.
 *
 * Who logs in: GOLDEN_PLATFORM_ADMIN_EMAIL/_PASSWORD whenever both are set, in every environment (hosted CI sets them
 * to a throwaway super_admin seeded by scripts/ci/golden-hosted/up.sh; setting them for the post-deploy verify swaps
 * the shared login for a dedicated principal with no code change). Otherwise E2E_ADMIN_* (today the post-deploy
 * verify and local runs: admin@isaflow.co.za, which must be a super_admin with at least one company there; see the
 * deploy pre-check in PR #1377), reusing the session the global setup already opened for that user. Failure
 * messages name only the login's email domain.
 *
 * How it reaches the admin host: middleware serves the console only for Host admin.isaflow.co.za, and on any other
 * host redirects /admin/* to the public admin site (in production, the LIVE colour, not the build under test). So:
 *  - Chromium resolves admin.isaflow.co.za to the server under test (--host-resolver-rules). Never call the admin
 *    origin through an APIRequestContext (page.request, request): Node does not use that resolver and would reach the
 *    real admin.isaflow.co.za. Routed documents are fetched from the server's own address instead.
 *  - Production's CSP carries upgrade-insecure-requests, which on this plain-http origin sends every script and API
 *    call to https on a port that speaks http (ERR_SSL_PROTOCOL_ERROR; the page never hydrates). Each DOCUMENT is
 *    routed and served with that one directive removed; every other directive (script-src, connect-src, ...) stays
 *    enforced, so a CSP violation is still a console error here.
 *  - A routed document has no IP address, so Chromium's Private Network Access checks treat the page as public and
 *    refuse its requests to 127.0.0.1 (ERR_FAILED). Those checks are switched off (helpers/adminConsole.ts
 *    LAUNCH_ARGS); this spec therefore says nothing about private-network rules.
 *  - The session cookies are copied onto the mapped host by NAME AND VALUE only, host-only, non-Secure, default
 *    SameSite, not HttpOnly. How the real cookies' Secure, HttpOnly, SameSite and Domain attributes behave on the
 *    public admin host is not exercised here.
 */
import { test, expect, type Page } from '@playwright/test';
import {
  LAUNCH_ARGS, adminApiCallCount, adminGet, adminPage, expectClean, platformAdminSession, responseTo, visit, type Watched,
} from './helpers/adminConsole';

test.use({ launchOptions: { args: LAUNCH_ARGS } });

let cookies: Array<{ name: string; value: string }> = [];
test.beforeAll(async () => { cookies = await platformAdminSession(); });

async function firstItemId(res: Awaited<ReturnType<typeof visit>>): Promise<string> {
  const body = (await res.json()) as { data?: { items?: Array<{ id?: unknown }> } };
  const id = body.data?.items?.[0]?.id;
  expect(typeof id, `${new URL(res.url()).pathname}: no first item`).toBe('string');
  return id as string;
}

const tab = (page: Page, name: string) => page.locator('main button', { hasText: new RegExp(`^\\s*${name}\\s*$`, 'i') });
const header = (page: Page, name: string) => page.locator('main thead th', { hasText: new RegExp(`^\\s*${name}\\s*$`) });

let companyId = '';

// Serial: the detail tests open the company the list test picked. 180 s: the slowest test took 12-47 s on velo's
// next dev (first compile of each page), and a hosted runner compiles cold.
test.describe.configure({ mode: 'serial', timeout: 180_000 });

test('dashboard and the companies list load; the list sorts by Name both ways and by Created', async ({ browser }) => {
  const w = await adminPage(browser, cookies);
  await visit(w, '/', /Dashboard/, /^\/api\/admin\/dashboard-stats/);
  await expectClean(w, 'dashboard');

  const list = await visit(w, '/companies', /^Companies$/, /^\/api\/admin\/companies$/);
  companyId = await firstItemId(list);
  await expect(w.page.locator('main tbody tr').first()).toBeVisible();

  /** Sorts by a column; the table must show one row per company the API returned, the first row being its first. */
  const sortedBy = async (column: string, by: string, dir: 'asc' | 'desc'): Promise<string[]> => {
    const res = await responseTo(w, adminGet(/^\/api\/admin\/companies$/, { sort_by: by, sort_dir: dir }),
      () => header(w.page, column).click());
    expect(res.status(), `sort ${by} ${dir}`).toBe(200);
    const names = ((await res.json()) as { data: { items: Array<{ name: string }> } }).data.items.map((c) => c.name);
    const rows = w.page.locator('main tbody tr');
    // Polled, both together: the count can already match the previous sort's page, and the first row re-renders a
    // beat after the response. A boolean, so no company name reaches a deploy log; whitespace normalised both sides.
    const norm = (t: string) => t.replace(/\s+/g, ' ').trim();
    await expect.poll(async () => {
      if (await rows.count() !== Math.max(names.length, 1)) return false;
      return names.length === 0 || norm(await rows.first().innerText({ timeout: 2000 })).includes(norm(names[0]!));
    }, { message: `sort ${by} ${dir}: one row per company, the first row holding the API's first company`, timeout: 15_000 }).toBe(true);
    return names;
  };
  const asc = await sortedBy('Name', 'name', 'asc');
  const desc = await sortedBy('Name', 'name', 'desc');
  // Order, not figures: with two distinct names on the page the two ends differ, whatever the names are.
  if (new Set(asc).size > 1) expect(desc[0] !== asc[0], 'Name desc starts where Name asc ends').toBe(true);
  await sortedBy('Created', 'created_at', 'asc');
  await expectClean(w, 'companies list');
  await w.context.close();
});

test('a company detail page switches through its tabs', async ({ browser }) => {
  expect(companyId, 'set by the companies-list test').not.toBe('');
  const w = await adminPage(browser, cookies);
  await visit(w, `/companies/${companyId}`, /Company Detail/, new RegExp(`^/api/admin/companies/${companyId}$`));
  for (const [name, column] of [['users', 'Email'], ['features', 'Feature']] as const) {
    await tab(w.page, name).click();
    await expect(header(w.page, column).first(), `company ${name} tab`).toBeVisible();
  }
  await tab(w.page, 'billing').click();
  await expect(w.page.getByText('Invoice History'), 'company billing tab').toBeVisible();
  await tab(w.page, 'info').click();
  await expect(w.page.getByText('Company Information'), 'company info tab').toBeVisible();
  await expectClean(w, 'company detail');
  await w.context.close();
});

test('the users list and a user detail page with its tabs load', async ({ browser }) => {
  const w = await adminPage(browser, cookies);
  const list = await visit(w, '/users', /^Users$/, /^\/api\/admin\/users$/);
  const userId = await firstItemId(list);
  await expect(w.page.locator('main tbody tr').first()).toBeVisible();
  await expectClean(w, 'users list');

  await visit(w, `/users/${userId}`, /User Detail/, new RegExp(`^/api/admin/users/${userId}$`));
  await tab(w.page, 'companies').click();
  await expect(header(w.page, 'Company').first(), 'user companies tab').toBeVisible();
  await tab(w.page, 'audit').click();
  await expect(header(w.page, 'Action').first(), 'user audit tab').toBeVisible();
  await tab(w.page, 'profile').click();
  await expectClean(w, 'user detail');
  await w.context.close();
});

/** Loads each page in turn: heading, first admin GET 200, then settled and clean. */
async function visitAll(w: Watched, pages: Array<[string, RegExp, RegExp]>): Promise<void> {
  for (const [path, heading, api] of pages) {
    await visit(w, path, heading, api);
    // The audit trail always draws its table (an empty filter is a row inside it).
    if (path === '/audit') await expect(w.page.locator('main table').first()).toBeVisible();
    await expectClean(w, path);
  }
}

test('billing pages load: overview, subscriptions, trials, plans', async ({ browser }) => {
  const w = await adminPage(browser, cookies);
  await visitAll(w, [
    ['/billing', /Billing Overview/, /^\/api\/admin\/billing\/overview/],
    ['/billing/subscriptions', /Subscriptions/, /^\/api\/admin\/billing\/subscriptions$/],
    ['/trials', /Trial/, /^\/api\/admin\/trials/],
    ['/billing/plans', /Plans/, /^\/api\/admin\/billing\/plans/],
  ]);
  await w.context.close();
});

test('platform pages load: feature flags, announcements, audit trail', async ({ browser }) => {
  const w = await adminPage(browser, cookies);
  await visitAll(w, [
    ['/features', /Feature Flags/, /^\/api\/admin\/features$/],
    ['/tools/announcements', /Announcements/, /^\/api\/admin\/announcements$/],
    ['/audit', /Audit Trail/, /^\/api\/admin\/audit$/],
  ]);
  await w.context.close();
});

test('ops pages load: email log, webhooks, settings (not System Health: its GET can alert)', async ({ browser }) => {
  const w = await adminPage(browser, cookies);
  await visitAll(w, [
    ['/email-log', /Email Delivery Log/, /^\/api\/admin\/email-log$/],
    ['/webhooks', /Webhook Management/, /^\/api\/admin\/webhooks$/],
    ['/settings', /Platform Settings/, /^\/api\/admin\/(settings|alert-settings)$/],
  ]);
  test.info().annotations.push({ type: 'admin API calls (whole file)', description: String(adminApiCallCount()) });
  await w.context.close();
});
