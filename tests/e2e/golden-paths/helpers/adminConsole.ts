/**
 * The admin console as z22 (z22-admin-console.spec.ts) sees it: where it lives, who logs in, and a page that records
 * every console error, page error, 5xx and blocked write. See the spec's header for why each piece is shaped so.
 */
import { existsSync, readFileSync } from 'node:fs';
import { expect, request as pwRequest, type Browser, type BrowserContext, type Page, type Request, type Response, type Route } from '@playwright/test';
import { GOLDEN_STATE_FILE } from '../_global-setup';
import { readGoldenSlot } from './goldenSlot';

export const ADMIN_HOST = 'admin.isaflow.co.za';
export const BASE_URL = process.env.BASE_URL || 'http://localhost:3200';
/** withAdmin allows 120 /api/admin requests per IP in a 60 s window; z22 fails before it gets near that. */
const ADMIN_API_WINDOW_MS = 60_000;
const ADMIN_API_WINDOW_LIMIT = 90;
/** How long no fetch/XHR may be in flight before a page counts as settled. */
const QUIET_MS = 750;
/** GET /api/admin/health runs checkAndAlert after commit: it writes the alert state and can send a real email/webhook. */
const NEVER_CALLED = new Set(['/api/admin/health']);
export const PRE_CHECK = 'see the deploy pre-check in PR #1377 before deploying';

export interface Target { origin: string; mapTo: string | null; direct: string | null }

/**
 * The admin origin to browse; the loopback address Chromium resolves the admin host to and the server's own address
 * for routed documents (null: real DNS). A BASE_URL it cannot use is returned as the reason, not thrown: this runs
 * when the spec loads, and a throw there would stop Playwright listing or running every other golden spec.
 */
export function adminTarget(baseUrl: string): Target | string {
  let base: URL;
  try { base = new URL(baseUrl); } catch { return `z22: BASE_URL "${baseUrl}" is not an absolute URL`; }
  if (['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) {
    const mapTo = base.hostname === '[::1]' ? '[::1]' : '127.0.0.1';
    const port = base.port ? `:${base.port}` : '';
    return { origin: `http://${ADMIN_HOST}${port}`, mapTo, direct: `http://${mapTo}${port}` };
  }
  if (base.hostname === 'isaflow.co.za' || base.hostname.endsWith('.isaflow.co.za')) {
    return { origin: `https://${ADMIN_HOST}`, mapTo: null, direct: null };
  }
  return `z22: cannot derive the admin console from BASE_URL ${baseUrl} (loopback or isaflow.co.za only)`;
}

export const RESOLVED = adminTarget(BASE_URL);
export const TARGET: Target = typeof RESOLVED === 'string' ? { origin: '', mapTo: null, direct: null } : RESOLVED;

/** Chromium flags for the mapped origin: the host mapping, and the Private Network Access checks off (see header). */
export const LAUNCH_ARGS = TARGET.mapTo
  ? [
    `--host-resolver-rules=MAP ${ADMIN_HOST} ${TARGET.mapTo}`,
    '--disable-features=BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights,LocalNetworkAccessChecks',
  ]
  : [];

type Cookie = { name: string; value: string };
const dedicated = (env: NodeJS.ProcessEnv) => Boolean(env.GOLDEN_PLATFORM_ADMIN_EMAIL || env.GOLDEN_PLATFORM_ADMIN_PASSWORD);

/** The dedicated pair when either half is set (both then required, never mixed with E2E_ADMIN_*), else E2E_ADMIN_*. */
function credentials(env: NodeJS.ProcessEnv): { email: string; password: string } {
  const own = dedicated(env);
  const email = own ? env.GOLDEN_PLATFORM_ADMIN_EMAIL : env.E2E_ADMIN_EMAIL;
  const password = own ? env.GOLDEN_PLATFORM_ADMIN_PASSWORD : env.E2E_ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error(own
      ? 'z22: set both GOLDEN_PLATFORM_ADMIN_EMAIL and GOLDEN_PLATFORM_ADMIN_PASSWORD, or neither'
      : 'z22 needs a super_admin login: GOLDEN_PLATFORM_ADMIN_EMAIL/_PASSWORD or E2E_ADMIN_EMAIL/_PASSWORD');
  }
  return { email, password };
}

/** name=value of every cookie a login set (expired ones dropped), read from Set-Cookie whatever its Domain/Secure. */
function setCookies(headers: string[]): Cookie[] {
  return headers.flatMap((header) => {
    const [pair, ...attrs] = header.split(';');
    const eq = pair!.indexOf('=');
    const value = pair!.slice(eq + 1).trim();
    const expired = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a));
    return eq > 0 && value && !expired ? [{ name: pair!.slice(0, eq).trim(), value }] : [];
  });
}

/**
 * The global setup's session, when it logged in as the same user z22 wants (no dedicated pair, no slot): one login
 * per run, not two. Null when it holds no access token (then z22 logs in itself).
 */
function globalSetupSession(env: NodeJS.ProcessEnv): Cookie[] | null {
  if (dedicated(env) || readGoldenSlot(env) !== null) return null;
  if (!existsSync(GOLDEN_STATE_FILE)) return null;
  const state = JSON.parse(readFileSync(GOLDEN_STATE_FILE, 'utf8')) as { cookies?: Cookie[] };
  const cookies = (state.cookies ?? []).filter((c) => c.value).map(({ name, value }) => ({ name, value }));
  return cookies.some((c) => c.name === 'sb-access-token') ? cookies : null;
}

const loginLabel = (email: string | undefined) => (email?.split('@')[1] ? `@${email.split('@')[1]}` : 'unknown');

/** The platform admin's session cookies, after proving it is a super_admin with a company (else a worded failure). */
export async function platformAdminSession(env: NodeJS.ProcessEnv = process.env): Promise<Cookie[]> {
  if (typeof RESOLVED === 'string') throw new Error(RESOLVED);
  const ctx = await pwRequest.newContext({ baseURL: BASE_URL });
  try {
    let cookies = globalSetupSession(env);
    if (!cookies) {
      const res = await ctx.post('/api/auth/login', { data: credentials(env) });
      expect(res.status(), `platform admin login: ${res.status()}`).toBe(200);
      cookies = setCookies(res.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie').map((h) => h.value));
    }
    expect(cookies.map((c) => c.name), 'no session cookie').toContain('sb-access-token');
    // users.role is what withPlatformAdmin and AdminLayout read. Fail here, in words, rather than as 403s or a page
    // that redirects to /login: in the post-deploy verify this failure rolls the deploy back.
    const me = await ctx.get('/api/auth/me', { headers: { cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; ') } });
    expect(me.status(), `/api/auth/me: ${me.status()}`).toBe(200);
    const { data } = (await me.json()) as { data: { user: { email?: string; role?: string | null }; memberships: unknown[] } };
    if (data.user.role !== 'super_admin') {
      throw new Error(`NOT_SUPER_ADMIN: the golden admin login (${loginLabel(data.user.email)}) is not a super admin here; ${PRE_CHECK}.`);
    }
    if (data.memberships.length === 0) {
      throw new Error(`the golden admin login (${loginLabel(data.user.email)}) belongs to no company here, so every admin page logs a 400 from the app shell's company lookup; ${PRE_CHECK}.`);
    }
    return cookies;
  } finally {
    await ctx.dispose();
  }
}

export interface Watched { page: Page; context: BrowserContext; problems: string[]; inflight: Set<Request> }

const adminCallTimes: number[] = [];
let adminApiCalls = 0;
/** /api/admin requests made by every page so far (reported, not limited: the limit is the 60 s window). */
export const adminApiCallCount = (): number => adminApiCalls;

/** Serves a routed admin document from the server under test with only upgrade-insecure-requests taken off its CSP. */
async function serveDocument(route: Route, direct: string): Promise<void> {
  const req = route.request();
  const url = new URL(req.url());
  const res = await route.fetch({
    url: `${direct}${url.pathname}${url.search}`,
    headers: { ...(await req.allHeaders()), host: url.host },
    maxRedirects: 0,
  });
  const headers = { ...res.headers() };
  const csp = headers['content-security-policy'];
  if (csp) {
    headers['content-security-policy'] = csp.split(';').map((d) => d.trim()).filter((d) => d && d !== 'upgrade-insecure-requests').join('; ');
  }
  await route.fulfill({ response: res, headers });
}

/** A fresh context on the admin host holding the session, recording problems; admin writes and /health are blocked. */
export async function adminPage(browser: Browser, cookies: Cookie[]): Promise<Watched> {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  await context.addCookies(cookies.map((c) => ({ ...c, url: TARGET.origin })));
  const problems: string[] = [];
  await context.route((u) => u.origin === TARGET.origin, async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path.startsWith('/api/admin/') && (req.method() !== 'GET' || NEVER_CALLED.has(path))) {
      problems.push(`blocked ${req.method()} ${path}: z22 is read-only`);
      return route.abort('blockedbyclient');
    }
    if (TARGET.direct && req.resourceType() === 'document') return serveDocument(route, TARGET.direct);
    return route.fallback();
  });
  const page = await context.newPage();
  const inflight = new Set<Request>();
  page.on('request', (r) => {
    if (['fetch', 'xhr'].includes(r.resourceType())) inflight.add(r);
    if (!new URL(r.url()).pathname.startsWith('/api/admin/')) return;
    adminApiCalls++;
    const now = Date.now();
    adminCallTimes.push(now);
    while (adminCallTimes[0]! < now - ADMIN_API_WINDOW_MS) adminCallTimes.shift();
    if (adminCallTimes.length === ADMIN_API_WINDOW_LIMIT) {
      problems.push(`${ADMIN_API_WINDOW_LIMIT} /api/admin calls inside 60 s (withAdmin limits 120 per IP)`);
    }
  });
  page.on('requestfinished', (r) => inflight.delete(r));
  page.on('requestfailed', (r) => inflight.delete(r));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console error: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 500) problems.push(`${r.status()} ${r.request().method()} ${r.url()}`); });
  return { page, context, problems, inflight };
}

export function adminGet(api: RegExp, params: Record<string, string> = {}): (r: Request) => boolean {
  return (r) => {
    const u = new URL(r.url());
    return r.method() === 'GET' && api.test(u.pathname) && Object.entries(params).every(([k, v]) => u.searchParams.get(k) === v);
  };
}

/**
 * Runs `act` and returns the response to the first request `match` accepts; neither promise is left to reject
 * unobserved. A request that gets no response (aborted as a write, refused) fails at once, with `problems`.
 */
export async function responseTo(w: Watched, match: (r: Request) => boolean, act: () => Promise<unknown>): Promise<Response> {
  const [req] = await Promise.all([w.page.waitForRequest(match), act()]);
  const res = await req.response();
  if (!res) {
    throw new Error(`${req.method()} ${new URL(req.url()).pathname} got no response (${req.failure()?.errorText ?? 'failed'}): ${w.problems.join('; ')}`);
  }
  return res;
}

/** Loads `path` on the admin host and waits for its first GET under `api`; asserts 200 and the heading. */
export async function visit(w: Watched, path: string, heading: RegExp, api: RegExp): Promise<Response> {
  const res = await responseTo(w, adminGet(api), () => w.page.goto(`${TARGET.origin}${path}`));
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
export async function expectClean(w: Watched, where: string): Promise<void> {
  let quietSince = Date.now();
  await expect.poll(() => {
    if (w.inflight.size > 0) quietSince = Date.now();
    return Date.now() - quietSince >= QUIET_MS ? 'quiet' : [...w.inflight].map((r) => r.url()).join(', ') || 'settling';
  }, { message: `${where}: requests still in flight`, timeout: 30_000, intervals: [100] }).toBe('quiet');
  expect(w.problems, `${where}: console errors, page errors, 5xx or blocked writes`).toEqual([]);
}
