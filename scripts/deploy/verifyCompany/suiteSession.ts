/**
 * A login session against the app that keeps cookies the way the golden suite's client does (Playwright's APIRequestContext,
 * playwright-core server/cookieStore.js and fetch.js), for the provisioner's readiness gate (suiteReadiness.ts): a gate whose client is
 * laxer than the suite's passes a run the suite then fails.
 *
 * The rules copied: a `Secure` cookie is sent over https, or over plain http to `localhost` / `*.localhost` only (never to an IP address);
 * a `Domain` the request host does not match is dropped when it is set; a cookie without one is host-only; `Path` prefixes;
 * `Max-Age<=0` deletes. Incident 2026-11-18: the seed's client (scripts/ci/golden-hosted/seed-demo-app.ts `Client`) sends every cookie
 * anywhere, so the provisioner seeded through http://127.0.0.1:3101 while the suite, there, got 401 on every GET.
 * tests/unit/ci/verifyCompanySuiteReadiness.test.ts holds this to Playwright's own behaviour.
 */
import { isLocalHostname, type SuiteGet } from '../../../tests/e2e/golden-paths/helpers/suitePreconditions';

interface Cookie { name: string; value: string; domain: string; path: string; secure: boolean }

/** playwright-core cookieStore domainMatches: exact host, or a dotted domain the host ends in. */
const domainMatches = (host: string, domain: string): boolean => host === domain || (domain.startsWith('.') && `.${host}`.endsWith(domain));

/** One Set-Cookie header, as received at `url`; null when Playwright would drop it. `expired` when it deletes the cookie. */
export function parseSetCookie(header: string, url: URL): (Cookie & { expired: boolean }) | null {
  const [pair = '', ...attrs] = header.split(';');
  const eq = pair.indexOf('=');
  if (eq <= 0) return null;
  const cookie = { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), domain: url.hostname, path: '/', secure: false, expired: false };
  for (const attr of attrs) {
    const i = attr.indexOf('=');
    const key = (i < 0 ? attr : attr.slice(0, i)).trim().toLowerCase();
    const val = i < 0 ? '' : attr.slice(i + 1).trim();
    if (key === 'secure') cookie.secure = true;
    else if (key === 'domain' && val) cookie.domain = `.${val.replace(/^\./, '').toLowerCase()}`;
    else if (key === 'path' && val.startsWith('/')) cookie.path = val;
    else if (key === 'max-age' && Number(val) <= 0) cookie.expired = true;
  }
  return domainMatches(url.hostname, cookie.domain) ? cookie : null;
}

/** Whether `c` goes with a request to `url` (playwright-core cookieStore.js Cookie.matches). */
export function cookieMatches(c: Cookie, url: URL): boolean {
  if (c.secure && url.protocol !== 'https:' && !isLocalHostname(url.hostname)) return false;
  return domainMatches(url.hostname, c.domain) && url.pathname.startsWith(c.path);
}

export class SuiteSession {
  private readonly jar = new Map<string, Cookie>();

  /** `timeoutMs` bounds every request: a hung app must not hold the provisioning run (and its deploy locks). */
  constructor(private readonly base: string, private readonly timeoutMs: number) {}

  private async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const url = new URL(path, this.base);
    const cookie = [...this.jar.values()].filter((c) => cookieMatches(c, url)).map((c) => `${c.name}=${c.value}`).join('; ');
    const res = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs), headers: { ...(init.headers as Record<string, string>), ...(cookie ? { cookie } : {}) } });
    for (const h of res.headers.getSetCookie()) {
      const c = parseSetCookie(h, url);
      if (!c) continue;
      const key = `${c.domain}|${c.path}|${c.name}`;
      if (c.expired) this.jar.delete(key); else this.jar.set(key, c);
    }
    return res;
  }

  /** The suite's login (helpers/goldenLogin.ts without a slot): POST /api/auth/login, then a routed page. @returns the login's status. */
  async login(email: string, password: string): Promise<number> {
    const res = await this.fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
    await res.arrayBuffer();
    if (res.status === 200) await (await this.fetch('/accounting')).arrayBuffer();
    return res.status;
  }

  readonly get: SuiteGet = async (path) => {
    const res = await this.fetch(path);
    const text = await res.text();
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { /* not JSON: the checks read the status */ }
    return { status: res.status, body };
  };
}
