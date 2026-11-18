/**
 * A login session against the app that keeps cookies the way the golden suite's client does (Playwright's APIRequestContext,
 * playwright-core 1.58 server/cookieStore.js, fetch.js and network.js), for the provisioner's readiness gate (suiteReadiness.ts): a gate
 * whose client is laxer than the suite's passes a run the suite then fails.
 *
 * The rules copied: a `Secure` cookie is sent over https, or over plain http to `localhost` / `*.localhost` only (never to an IP address);
 * `Domain` (dotted ones get a leading dot, a dotless one stays as written; one the response's host does not match is dropped; none is
 * host-only); `Path` (none, or one not starting with `/`, is the response URL's directory; matched on a `/` boundary); `Expires` and
 * `Max-Age` (the last one wins; at or before now deletes the cookie); up to 20 redirects followed, cookies stored at every hop.
 * Incident 2026-11-18: the seed's client (scripts/ci/golden-hosted/seed-demo-app.ts `Client`) sends every cookie anywhere, so the
 * provisioner seeded through http://127.0.0.1:3101 while the suite, there, got 401 on every GET.
 * tests/unit/ci/verifyCompanySuiteReadiness.test.ts holds this to Playwright's own behaviour, request for request.
 */
import { isLocalHostname, type SuiteGet } from '../../../tests/e2e/golden-paths/helpers/suitePreconditions';

interface Cookie { name: string; value: string; domain: string; path: string; secure: boolean; /** Unix seconds; -1 = session cookie. */ expires: number }

const MAX_EXPIRES = 253_402_300_799;
const MAX_REDIRECTS = 20;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/** playwright-core cookieStore domainMatches: exact host, or a dotted domain the host ends in. */
const domainMatches = (host: string, domain: string): boolean => host === domain || (domain.startsWith('.') && `.${host}`.endsWith(domain));

/** playwright-core cookieStore pathMatches: the cookie's path is the request's path or one of its parent directories. */
function pathMatches(value: string, path: string): boolean {
  if (value === path) return true;
  return (value.endsWith('/') ? value : `${value}/`).startsWith(path.endsWith('/') ? path : `${path}/`);
}

const expired = (c: Cookie): boolean => c.expires !== -1 && c.expires * 1000 < Date.now();

/** One Set-Cookie header, as received at `url` (cookieStore.js parseRawCookie, then fetch.js _parseSetCookieHeader); null when it is dropped. */
export function parseSetCookie(header: string, url: URL): Cookie | null {
  const pairs = header.split(';').filter((s) => s.trim().length > 0).map((p): [string, string] => {
    const i = p.indexOf('=');
    return i === -1 ? [p.trim(), ''] : [p.slice(0, i).trim(), p.slice(i + 1).trim()];
  });
  const first = pairs[0];
  if (!first) return null;
  const c: Cookie = { name: first[0], value: first[1], domain: '', path: '', secure: false, expires: -1 };
  for (const [key, val] of pairs.slice(1)) {
    switch (key.toLowerCase()) {
      case 'expires': { const ms = +new Date(val); if (Number.isFinite(ms)) c.expires = ms <= 0 ? 0 : Math.min(ms / 1000, MAX_EXPIRES); break; }
      case 'max-age': { const sec = parseInt(val, 10); if (Number.isFinite(sec)) c.expires = sec <= 0 ? 0 : Math.min(Date.now() / 1000 + sec, MAX_EXPIRES); break; }
      case 'domain': c.domain = val.toLocaleLowerCase(); if (c.domain && !c.domain.startsWith('.') && c.domain.includes('.')) c.domain = `.${c.domain}`; break;
      case 'path': c.path = val; break;
      case 'secure': c.secure = true; break;
    }
  }
  if (!c.domain) c.domain = url.hostname;
  if (!domainMatches(url.hostname, c.domain)) return null;
  if (!c.path.startsWith('/')) c.path = `/${url.pathname.slice(1).split('/').slice(0, -1).join('/')}`;
  return c;
}

/** Whether `c` goes with a request to `url` (cookieStore.js Cookie.matches; expiry is the jar's). */
export function cookieMatches(c: Cookie, url: URL): boolean {
  if (c.secure && url.protocol !== 'https:' && !isLocalHostname(url.hostname)) return false;
  return domainMatches(url.hostname, c.domain) && pathMatches(url.pathname, c.path);
}

/** cookieStore.js CookieStore: cookies by name; one with the same name, domain and path is replaced, an expired one is gone. */
class CookieJar {
  private readonly byName = new Map<string, Cookie[]>();

  add(c: Cookie): void {
    const kept = (this.byName.get(c.name) ?? []).filter((o) => o.domain !== c.domain || o.path !== c.path);
    this.byName.set(c.name, [...kept, c].filter((o) => !expired(o)));
  }

  /** The Cookie header for a request to `url`; '' when none goes. */
  header(url: URL): string {
    const out: string[] = [];
    for (const [name, list] of [...this.byName]) {
      const live = list.filter((o) => !expired(o));
      if (live.length === 0) { this.byName.delete(name); continue; }
      this.byName.set(name, live);
      for (const c of live) if (cookieMatches(c, url)) out.push(`${c.name}=${c.value}`);
    }
    return out.join('; ');
  }
}

/** Playwright (fetch.js) turns a POST into a GET after a 301/302, and any non-GET/HEAD after a 303, dropping the body and its headers. */
const BODY_HEADERS = ['content-encoding', 'content-language', 'content-length', 'content-location', 'content-type'];

export class SuiteSession {
  private readonly jar = new CookieJar();

  /** `timeoutMs` bounds every call, redirects included: a hung app must not hold the provisioning run (and its deploy locks). */
  constructor(private readonly base: string, private readonly timeoutMs: number) {}

  /** One request, then its redirects (at most 20, as Playwright), the cookies of every response stored and the jar's sent on every hop. */
  private async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    let url = new URL(path, this.base);
    let method = init.method ?? 'GET';
    let body = init.body;
    let headers = { ...(init.headers as Record<string, string> | undefined) };
    for (let left = MAX_REDIRECTS; ; left--) {
      const cookie = this.jar.header(url);
      const res = await fetch(url, { method, body, redirect: 'manual', signal, headers: cookie ? { ...headers, cookie } : headers });
      for (const h of res.headers.getSetCookie()) {
        const c = parseSetCookie(h, url);
        if (c) this.jar.add(c);
      }
      if (!REDIRECT_STATUS.has(res.status)) return res;
      if (left === 0) { await res.body?.cancel(); throw new Error('Max redirect count exceeded'); }
      const location = res.headers.get('location');
      if (!location) return res;
      await res.body?.cancel();
      try { url = new URL(location, url); } catch { throw new Error(`uri requested responds with an invalid redirect URL: ${location}`); }
      if (((res.status === 301 || res.status === 302) && method === 'POST') || (res.status === 303 && method !== 'GET' && method !== 'HEAD')) {
        method = 'GET';
        body = undefined;
        headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !BODY_HEADERS.includes(k.toLowerCase())));
      }
    }
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
