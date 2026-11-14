/**
 * Golden path (z22): the admin console (admin.isaflow.co.za) loads, read-only.
 *
 * Every page a platform admin uses day to day loads with its heading, its first admin API answers 200, and there
 * is no console error, page error or 5xx response on the way. The companies list sorts by Name both ways and by
 * Created; a company's and a user's detail tabs switch and show their table.
 *
 * Read-only and figure-free, because it runs in the post-deploy verify against production (a red run rolls the
 * deploy back): nothing is clicked that saves, sends, suspends, converts, deletes or exports, and no number or
 * name from the data is asserted (a company and a user are picked from the list the page loaded).
 *
 * Who logs in: GOLDEN_PLATFORM_ADMIN_EMAIL/_PASSWORD whenever both are set, in every environment (hosted CI sets them
 * to a throwaway super_admin seeded by scripts/ci/golden-hosted/up.sh; setting them for the post-deploy verify swaps
 * the shared login for a dedicated principal with no code change). Otherwise E2E_ADMIN_* (today the post-deploy
 * verify and local runs: admin@isaflow.co.za, which must be a super_admin with at least one company there; see the
 * deploy pre-check in PR #1377). The hosted suite's own golden user is a company admin and is refused by every admin
 * API. Failure messages name only the login's email domain.
 *
 * How it reaches the admin host: middleware serves the console only for Host admin.isaflow.co.za, and on any other
 * host redirects /admin/* to the public admin site (in production, the LIVE colour, not the build under test). So
 * Chromium resolves admin.isaflow.co.za to the server under test (--host-resolver-rules), CSP is bypassed on that
 * plain-http origin (see adminPage), and the session cookies are copied onto that host, non-Secure. Never
 * call the admin origin through an APIRequestContext (page.request, request): Node does not use Chromium's resolver
 * and would reach the real admin.isaflow.co.za.
 */
import { test, expect, request as pwRequest, type Browser, type BrowserContext, type Page, type Request, type Response } from '@playwright/test';

const ADMIN_HOST = 'admin.isaflow.co.za';
const BASE_URL = process.env.BASE_URL || 'http://localhost:3200';
/** withAdmin allows 120 /api/admin requests a minute per IP; the whole file stays well under that. */
const ADMIN_API_BUDGET = 80;
/** How long no fetch/XHR may be in flight before a page counts as settled. */
const QUIET_MS = 750;

interface Target { origin: string; mapTo: string | null }

/**
 * The admin origin to browse, and the loopback address Chromium must resolve the admin host to (null: real DNS).
 * A BASE_URL it cannot use is returned as the reason, not thrown: this runs when the file loads, and a throw there
 * would stop Playwright listing or running every other golden spec. beforeAll fails with the reason instead.
 */
function adminTarget(baseUrl: string): Target | string {
  let base: URL;
  try { base = new URL(baseUrl); } catch { return `z22: BASE_URL "${baseUrl}" is not an absolute URL`; }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if (loopback) {
    return { origin: `http://${ADMIN_HOST}${base.port ? `:${base.port}` : ''}`, mapTo: base.hostname === '[::1]' ? '[::1]' : '127.0.0.1' };
  }
  if (base.hostname.endsWith('isaflow.co.za')) return { origin: `https://${ADMIN_HOST}`, mapTo: null };
  return `z22: cannot derive the admin console from BASE_URL ${baseUrl} (loopback or *.isaflow.co.za only)`;
}

const RESOLVED = adminTarget(BASE_URL);
const TARGET: Target = typeof RESOLVED === 'string' ? { origin: '', mapTo: null } : RESOLVED;
test.use({
  launchOptions: {
    args: TARGET.mapTo
      ? [`--host-resolver-rules=MAP ${ADMIN_HOST} ${TARGET.mapTo}`]
      : [],
  },
});

/** The dedicated pair when either half is set (both then required, never mixed with E2E_ADMIN_*), else E2E_ADMIN_*. */
function platformAdminCredentials(): { email: string; password: string } {
  const env = process.env;
  const dedicated = Boolean(env.GOLDEN_PLATFORM_ADMIN_EMAIL || env.GOLDEN_PLATFORM_ADMIN_PASSWORD);
  const email = dedicated ? env.GOLDEN_PLATFORM_ADMIN_EMAIL : env.E2E_ADMIN_EMAIL;
  const password = dedicated ? env.GOLDEN_PLATFORM_ADMIN_PASSWORD : env.E2E_ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error(dedicated
      ? 'z22: set both GOLDEN_PLATFORM_ADMIN_EMAIL and GOLDEN_PLATFORM_ADMIN_PASSWORD, or neither'
      : 'z22 needs a super_admin login: GOLDEN_PLATFORM_ADMIN_EMAIL/_PASSWORD or E2E_ADMIN_EMAIL/_PASSWORD');
  }
  return { email, password };
}

/** The login named by its email domain only, for failure messages that land in deploy logs. */
function loginLabel(email: string | undefined): string {
  const domain = email?.split('@')[1];
  return domain ? `@${domain}` : 'unknown';
}

const PRE_CHECK = 'see the deploy pre-check in PR #1377 before deploying';

/** name=value of every cookie the login set (expired ones dropped), read from Set-Cookie whatever its Domain/Secure. */
function sessionCookies(setCookieHeaders: string[]): Array<{ name: string; value: string }> {
  return setCookieHeaders.flatMap((header) => {
    const [pair, ...attrs] = header.split(';');
    const eq = pair!.indexOf('=');
    const name = pair!.slice(0, eq).trim();
    const value = pair!.slice(eq + 1).trim();
    const expired = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a));
    return eq > 0 && value && !expired ? [{ name, value }] : [];
  });
}

let cookies: Array<{ name: string; value: string }> = [];
let adminApiCalls = 0;

test.beforeAll(async () => {
  if (typeof RESOLVED === 'string') throw new Error(RESOLVED);
  const ctx = await pwRequest.newContext({ baseURL: BASE_URL });
  const res = await ctx.post('/api/auth/login', { data: platformAdminCredentials() });
  expect(res.status(), `platform admin login: ${res.status()}`).toBe(200);
  cookies = sessionCookies(res.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie').map((h) => h.value));
  expect(cookies.map((c) => c.name), 'login set no session cookie').toContain('sb-access-token');
  // users.role is what withPlatformAdmin and AdminLayout read. Fail here, in words, rather than as 403s or a page
  // that redirects to /login: in the post-deploy verify this failure rolls the deploy back.
  const me = await ctx.get('/api/auth/me', { headers: { cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; ') } });
  expect(me.status(), `/api/auth/me after login: ${me.status()}`).toBe(200);
  const { data } = (await me.json()) as { data: { user: { email?: string; role?: string | null }; memberships: unknown[] } };
  await ctx.dispose();
  if (data.user.role !== 'super_admin') {
    throw new Error(`NOT_SUPER_ADMIN: the golden admin login (${loginLabel(data.user.email)}) is not a super admin here; ${PRE_CHECK}.`);
  }
  if (data.memberships.length === 0) {
    throw new Error(`the golden admin login (${loginLabel(data.user.email)}) belongs to no company here, so every admin page logs a 400 from the app shell's company lookup; ${PRE_CHECK}.`);
  }
});

interface Watched { page: Page; context: BrowserContext; problems: string[]; inflight: Set<Request> }

/** A fresh context on the admin host holding the session, recording every console error, page error and 5xx. */
async function adminPage(browser: Browser): Promise<Watched> {
  // bypassCSP only on the mapped plain-http origin: production's CSP carries upgrade-insecure-requests, which sends
  // every script and API call to https on a port that speaks http (ERR_SSL_PROTOCOL_ERROR, the page never hydrates).
  // Neither --unsafely-treat-insecure-origin-as-secure nor stripping that one directive from the routed document
  // got the page to load (2026-11-14). Cost: a CSP violation on these pages is not reported here.
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] }, bypassCSP: TARGET.mapTo !== null });
  await context.addCookies(cookies.map((c) => ({ ...c, url: TARGET.origin })));
  const page = await context.newPage();
  const problems: string[] = [];
  const inflight = new Set<Request>();
  page.on('request', (r) => { if (['fetch', 'xhr'].includes(r.resourceType())) inflight.add(r); });
  page.on('requestfinished', (r) => inflight.delete(r));
  page.on('requestfailed', (r) => inflight.delete(r));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console error: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 500) problems.push(`${r.status()} ${r.request().method()} ${r.url()}`); });
  page.on('request', (r) => { if (new URL(r.url()).pathname.startsWith('/api/admin/')) adminApiCalls++; });
  return { page, context, problems, inflight };
}

function adminGet(api: RegExp): (r: Response) => boolean {
  return (r) => r.request().method() === 'GET' && api.test(new URL(r.url()).pathname);
}

/** Loads `path` on the admin host and waits for its first GET under `api`; asserts 200 and the heading. */
async function visit(w: Watched, path: string, heading: RegExp, api: RegExp): Promise<Response> {
  const answered = w.page.waitForResponse(adminGet(api));
  await w.page.goto(`${TARGET.origin}${path}`);
  const res = await answered;
  if (res.status() === 403 && /NOT_SUPER_ADMIN/.test(await res.text())) {
    throw new Error(`NOT_SUPER_ADMIN on ${path}: the golden admin login is not a super admin here; ${PRE_CHECK}.`);
  }
  expect(res.status(), `${path}: ${res.url()}`).toBe(200);
  await expect(w.page.getByRole('heading', { level: 1, name: heading }).first()).toBeVisible();
  return res;
}

/**
 * Waits until no fetch/XHR has been in flight for QUIET_MS, then fails on anything recorded so far. Not
 * 'networkidle': on the mapped admin host under next dev it never settled (90 s).
 */
async function expectClean(w: Watched, where: string): Promise<void> {
  let quietSince = Date.now();
  await expect.poll(() => {
    if (w.inflight.size > 0) quietSince = Date.now();
    return Date.now() - quietSince >= QUIET_MS ? 'quiet' : [...w.inflight].map((r) => r.url()).join(', ') || 'settling';
  }, { message: `${where}: requests still in flight`, timeout: 30_000, intervals: [100] }).toBe('quiet');
  expect(w.problems, `${where}: console errors, page errors or 5xx`).toEqual([]);
  expect(adminApiCalls, 'admin API calls so far (withAdmin limit: 120 a minute)').toBeLessThan(ADMIN_API_BUDGET);
}

async function firstItemId(res: Response): Promise<string> {
  const body = (await res.json()) as { data?: { items?: Array<{ id?: unknown }> } };
  const id = body.data?.items?.[0]?.id;
  expect(typeof id, `${res.url()}: no first item`).toBe('string');
  return id as string;
}

const tab = (page: Page, name: string) => page.locator('main button', { hasText: new RegExp(`^\\s*${name}\\s*$`, 'i') });
const header = (page: Page, name: string) => page.locator('main thead th', { hasText: new RegExp(`^\\s*${name}\\s*$`) });

let companyId = '';

// Serial: the detail tests open the company the list test picked. 180 s: the slowest test took 12-47 s on velo's
// next dev (first compile of each page), and a hosted runner compiles cold.
test.describe.configure({ mode: 'serial', timeout: 180_000 });

test('dashboard and the companies list load; the list sorts by Name both ways and by Created', async ({ browser }) => {
  const w = await adminPage(browser);
  await visit(w, '/', /Dashboard/, /^\/api\/admin\/dashboard-stats/);
  await expectClean(w, 'dashboard');

  const list = await visit(w, '/companies', /^Companies$/, /^\/api\/admin\/companies$/);
  companyId = await firstItemId(list);
  await expect(w.page.locator('main tbody tr').first()).toBeVisible();

  const sortedBy = async (column: string, by: string, dir: 'asc' | 'desc'): Promise<string[]> => {
    const answered = w.page.waitForResponse((r) => adminGet(/^\/api\/admin\/companies$/)(r)
      && new URL(r.url()).searchParams.get('sort_by') === by && new URL(r.url()).searchParams.get('sort_dir') === dir);
    await header(w.page, column).click();
    const res = await answered;
    expect(res.status(), `sort ${by} ${dir}`).toBe(200);
    const body = (await res.json()) as { data: { items: Array<{ name: string }> } };
    const names = body.data.items.map((c) => c.name);
    await expect(w.page.locator('main tbody tr').first()).toContainText(names[0] ?? 'No companies found');
    return names;
  };
  const asc = await sortedBy('Name', 'name', 'asc');
  const desc = await sortedBy('Name', 'name', 'desc');
  // Order, not figures: with two distinct names on the page the two ends differ, whatever the names are.
  if (new Set(asc).size > 1) expect(desc[0], 'Name desc starts where Name asc ends').not.toBe(asc[0]);
  await sortedBy('Created', 'created_at', 'asc');
  await expectClean(w, 'companies list');
  await w.context.close();
});

test('a company detail page switches through its tabs', async ({ browser }) => {
  expect(companyId, 'set by the companies-list test').not.toBe('');
  const w = await adminPage(browser);
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
  const w = await adminPage(browser);
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

test('billing pages load: overview, subscriptions, trials, plans', async ({ browser }) => {
  const w = await adminPage(browser);
  await visit(w, '/billing', /Billing Overview/, /^\/api\/admin\/billing\/overview/);
  await expectClean(w, 'billing overview');
  await visit(w, '/billing/subscriptions', /Subscriptions/, /^\/api\/admin\/billing\/subscriptions$/);
  await expectClean(w, 'subscriptions');
  await visit(w, '/trials', /Trial/, /^\/api\/admin\/trials/);
  await expectClean(w, 'trials');
  await visit(w, '/billing/plans', /Plans/, /^\/api\/admin\/billing\/plans/);
  await expectClean(w, 'plans');
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

test('platform pages load: feature flags, announcements, audit trail', async ({ browser }) => {
  const w = await adminPage(browser);
  await visitAll(w, [
    ['/features', /Feature Flags/, /^\/api\/admin\/features$/],
    ['/tools/announcements', /Announcements/, /^\/api\/admin\/announcements$/],
    ['/audit', /Audit Trail/, /^\/api\/admin\/audit$/],
  ]);
  await w.context.close();
});

test('ops pages load: email log, webhooks, settings, health', async ({ browser }) => {
  const w = await adminPage(browser);
  await visitAll(w, [
    ['/email-log', /Email Delivery Log/, /^\/api\/admin\/email-log$/],
    ['/webhooks', /Webhook Management/, /^\/api\/admin\/webhooks$/],
    ['/settings', /Platform Settings/, /^\/api\/admin\/(settings|alert-settings)$/],
    ['/health', /System Health/, /^\/api\/admin\/health$/],
  ]);
  test.info().annotations.push({ type: 'admin API calls (whole file)', description: String(adminApiCalls) });
  await w.context.close();
});
