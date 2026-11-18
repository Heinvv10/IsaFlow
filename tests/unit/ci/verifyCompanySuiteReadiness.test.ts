// The verify provisioner's last gate: log in through the app as the suite will (verify login AND approver) and run the suite's own
// start-up checks (helpers/suitePreconditions.ts). Its client must keep cookies the way the suite's client does, or the gate passes a
// run the suite then fails: the 2026-11-18 incident (Secure cookies, http://127.0.0.1:3101). A local server plays the app; its
// cookie flags are the app's own (src/lib/auth/cookies.ts, production: HttpOnly; SameSite=Lax; Secure).
import { promises as dns } from 'node:dns';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { request as pwRequest } from '@playwright/test';
import { SuiteSession } from '../../../scripts/deploy/verifyCompany/suiteSession';
import { suiteProblems } from '../../../scripts/deploy/verifyCompany/suiteReadiness';
import { VERIFY_LOGIN, APPROVER_LOGIN } from '../../../scripts/deploy/verifyCompany/identity';

interface AppOpts { secure: boolean; activeCompany?: 'c1' | 'c2'; approverCompanies?: number; domain?: string }

const home = { companyId: 'c1', companyName: 'Deploy Verification', isDemo: true };
const sandbox = { companyId: 'c2', companyName: '0GP Golden Migration Sandbox', isDemo: true };
let server: http.Server | null = null;
afterEach(async () => { if (server) await new Promise((r) => server!.close(r)); server = null; });

/** The app as the suite meets it: login sets the session cookie, every API GET needs it. Returns its port. */
async function startApp(o: AppOpts): Promise<number> {
  const flags = `Path=/; Max-Age=3600; HttpOnly; SameSite=Lax${o.secure ? '; Secure' : ''}${o.domain ? `; Domain=${o.domain}` : ''}`;
  server = http.createServer((req, res) => {
    const json = (status: number, body: unknown) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
    if (req.method === 'POST' && req.url === '/api/auth/login') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const who = (JSON.parse(raw) as { email: string }).email;
        res.setHeader('Set-Cookie', [`sb-access-token=${who}; ${flags}`, `isaflow_csrf=x; Path=/; SameSite=Lax${o.secure ? '; Secure' : ''}`]);
        json(200, { success: true });
      });
      return;
    }
    if (req.url === '/accounting') { res.statusCode = 200; res.end('<html/>'); return; }
    const who = /sb-access-token=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    if (!who) return json(401, { success: false, error: { code: 'UNAUTHORIZED' } });
    if (req.url === '/api/accounting/companies?action=user-companies') {
      if (decodeURIComponent(who) === APPROVER_LOGIN.email) return json(200, { success: true, data: { items: o.approverCompanies === 2 ? [home, sandbox] : [home], activeCompanyId: 'c1' } });
      return json(200, { success: true, data: { items: [home, sandbox], activeCompanyId: o.activeCompany ?? 'c1' } });
    }
    if (req.url?.startsWith('/api/accounting/chart-of-accounts?subtype=')) return json(200, { success: true, data: [{ id: 'a', isSystemAccount: true }] });
    return json(404, { success: false });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return (server.address() as AddressInfo).port;
}

const logins = { verify: { email: VERIFY_LOGIN.email, password: 'p1' }, approver: { email: APPROVER_LOGIN.email, password: 'p2' } };

describe('SuiteSession keeps cookies as the suite\'s client (Playwright) does', () => {
  it.each([
    ['127.0.0.1', true], ['localhost', true], ['127.0.0.1', false], ['localhost', false],
  ] as const)('host %s, Secure cookies %s: the same status after login as Playwright\'s request context', async (host, secure) => {
    const port = await startApp({ secure });
    const base = `http://${host}:${port}`;
    const pw = await pwRequest.newContext({ baseURL: base });
    await pw.post('/api/auth/login', { data: { email: VERIFY_LOGIN.email, password: 'p' } });
    const pwStatus = (await pw.get('/api/accounting/companies?action=user-companies')).status();
    await pw.dispose();
    const s = new SuiteSession(base, 5_000);
    expect(await s.login(VERIFY_LOGIN.email, 'p')).toBe(200);
    expect((await s.get('/api/accounting/companies?action=user-companies')).status).toBe(pwStatus);
    expect(pwStatus).toBe(secure && host === '127.0.0.1' ? 401 : 200); // the rule itself, so a Playwright change shows here
  });

  it('a cookie whose Domain the host does not match is dropped, as Playwright drops it', async () => {
    const port = await startApp({ secure: false, domain: '.isaflow.co.za' });
    const s = new SuiteSession(`http://localhost:${port}`, 5_000);
    await s.login(VERIFY_LOGIN.email, 'p');
    expect((await s.get('/api/accounting/companies?action=user-companies')).status).toBe(401);
  });
});

/** One request as the server saw it. */
interface Seen { method: string; url: string; cookie: string }
interface Reply { status?: number; set?: string[]; location?: string }

/** A scripted app that answers `METHOD /path` from `routes` (200 otherwise) and records every request it gets. Returns its port and log. */
async function startScript(routes: Record<string, Reply | (() => Reply)>): Promise<{ port: number; seen: Seen[] }> {
  const seen: Seen[] = [];
  server = http.createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', cookie: req.headers.cookie ?? '' });
    const r = routes[`${req.method} ${req.url}`];
    const reply = (typeof r === 'function' ? r() : r) ?? {};
    if (reply.set) res.setHeader('Set-Cookie', reply.set);
    if (reply.location) res.setHeader('Location', reply.location);
    res.statusCode = reply.status ?? 200;
    res.setHeader('content-type', 'application/json');
    req.resume();
    res.end('{}');
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return { port: (server.address() as AddressInfo).port, seen };
}

/**
 * The same journey through Playwright's request context and through SuiteSession against one scripted app: the login (POST, then GET
 * /accounting), then a GET of every probe. What the app saw (method, url and Cookie header, every hop) must be identical, and so must the
 * outcome (a status, or that the call threw).
 */
async function parity(host: string, routes: Record<string, Reply | (() => Reply)>, probes: string[]): Promise<{ pw: Seen[]; mine: Seen[]; outcomes: string[] }> {
  const { port, seen } = await startScript(routes);
  const base = `http://${host}:${port}`;
  const outcome = async (run: () => Promise<number>): Promise<string> => run().then(String, (e: Error) => (/Max redirect count exceeded/.test(e.message) ? 'threw max redirects' : `threw ${e.message}`));
  const pw = await pwRequest.newContext({ baseURL: base });
  const pwOut = [await outcome(async () => (await pw.post('/api/auth/login', { data: { email: 'a', password: 'b' } })).status())];
  if (pwOut[0] === '200') { await pw.get('/accounting'); for (const p of probes) pwOut.push(await outcome(async () => (await pw.get(p)).status())); }
  await pw.dispose();
  const pwSeen = seen.splice(0);
  const s = new SuiteSession(base, 5_000);
  const mineOut = [await outcome(() => s.login('a', 'b'))];
  if (mineOut[0] === '200') for (const p of probes) mineOut.push(await outcome(async () => (await s.get(p)).status));
  expect(mineOut).toEqual(pwOut);
  return { pw: pwSeen, mine: seen, outcomes: pwOut };
}

const subLocalhostResolves = await dns.lookup('sub.localhost').then(() => true, () => false);
const LOGIN = 'POST /api/auth/login';
const cookiesSeen = (log: Seen[], url: string): string[] => log.filter((r) => r.url === url).map((r) => r.cookie);

describe('SuiteSession cookie and redirect parity with Playwright, request for request', () => {
  const NOW_PLUS = (s: number) => new Date(Date.now() + s * 1000).toUTCString();
  it.each([
    ['Max-Age=0 deletes', ['a=1; Path=/'], ['a=; Path=/; Max-Age=0'], ['a=1', '']],
    ['a past Expires deletes', ['a=1; Path=/'], ['a=; Path=/; Expires=Wed, 01 Jan 2020 00:00:00 GMT'], ['a=1', '']],
    ['the epoch as Expires deletes', ['a=1; Path=/'], ['a=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT'], ['a=1', '']],
    ['a future Expires keeps', ['a=1; Path=/'], [`a=2; Path=/; Expires=${NOW_PLUS(3600)}`], ['a=1', 'a=2']],
    ['the last of Max-Age and Expires wins (Max-Age=0 after a future Expires)', ['a=1; Path=/'], [`a=2; Path=/; Expires=${NOW_PLUS(3600)}; Max-Age=0`], ['a=1', '']],
    ['the last of Max-Age and Expires wins (a future Expires after Max-Age=0)', ['a=1; Path=/'], [`a=2; Path=/; Max-Age=0; Expires=${NOW_PLUS(3600)}`], ['a=1', 'a=2']],
  ] as const)('%s', async (_name, first, second, expected) => {
    const { pw, mine } = await parity('localhost', { [LOGIN]: { set: [...first] }, 'GET /clear': { set: [...second] } }, ['/probe', '/clear', '/probe']);
    expect(cookiesSeen(pw, '/probe')).toEqual([...expected]);
    expect(mine).toEqual(pw);
  });

  it('the login is the POST and then a GET of /accounting (where the app issues the CSRF cookie), as the suite\'s', async () => {
    const { pw, mine } = await parity('localhost', { [LOGIN]: { set: ['a=1; Path=/'] }, 'GET /accounting': { set: ['isaflow_csrf=x; Path=/'] } }, ['/probe']);
    expect(pw.map((r) => `${r.method} ${r.url}`)).toEqual([LOGIN, 'GET /accounting', 'GET /probe']);
    expect(cookiesSeen(pw, '/probe')).toEqual(['a=1; isaflow_csrf=x']);
    expect(mine).toEqual(pw);
  });

  it('a cookie with no Path goes to its directory and below, as Playwright sends it', async () => {
    const { pw, mine } = await parity('localhost', { 'POST /api/auth/login': { set: ['a=1'] } }, ['/api/auth/x', '/api/auth', '/api/authz', '/api/other', '/accounting', '/api/auth/deeper/y']);
    expect(cookiesSeen(pw, '/api/auth/x')).toEqual(['a=1']);
    expect(cookiesSeen(pw, '/api/other')).toEqual(['']);
    expect(mine).toEqual(pw);
  });

  it('Path=/api/x matches /api/x and /api/x/z but not /api/xy', async () => {
    const { pw, mine } = await parity('localhost', { [LOGIN]: { set: ['a=1; Path=/api/x'] } }, ['/api/x', '/api/x/z', '/api/xy', '/api/x/']);
    expect([cookiesSeen(pw, '/api/x'), cookiesSeen(pw, '/api/x/z'), cookiesSeen(pw, '/api/xy'), cookiesSeen(pw, '/api/x/')]).toEqual([['a=1'], ['a=1'], [''], ['a=1']]);
    expect(mine).toEqual(pw);
  });

  it.each([
    ['localhost', 'Domain=localhost', true], ['localhost', 'Domain=.localhost', true], ['127.0.0.1', 'Domain=localhost', false], ['127.0.0.1', 'Domain=127.0.0.1', true],
    ['localhost', 'Domain=LOCALHOST', true],  ['localhost', 'Domain=example.com', false],
  ] as const)('host %s with %s: the cookie is sent: %s', async (host, domain, sent) => {
    const { pw, mine } = await parity(host, { [LOGIN]: { set: [`a=1; Path=/; ${domain}`] } }, ['/probe']);
    expect(cookiesSeen(pw, '/probe')).toEqual([sent ? 'a=1' : '']);
    expect(mine).toEqual(pw);
  });

  // A dotted host that is local without any DNS setup: where a dotless Domain (it stays as written) and a dotted one differ. Skipped where
  // the machine cannot resolve *.localhost (the case is then not run, and says so).
  it.skipIf(!subLocalhostResolves).each([['Domain=localhost', false], ['Domain=.localhost', true]] as const)('host sub.localhost with %s: the cookie is sent: %s', async (domain, sent) => {
    const { pw, mine } = await parity('sub.localhost', { [LOGIN]: { set: [`a=1; Path=/; ${domain}`] } }, ['/probe']);
    expect(cookiesSeen(pw, '/probe')).toEqual([sent ? 'a=1' : '']);
    expect(mine).toEqual(pw);
  });

  it('follows redirects, storing the cookies of every hop (a POST that redirects becomes a GET)', async () => {
    const { pw, mine } = await parity('localhost', {
      [LOGIN]: { status: 302, location: '/hop/1', set: ['sb=1; Path=/'] },
      'GET /hop/1': { status: 307, location: '/hop/2', set: ['h1=1; Path=/'] },
      'GET /hop/2': { status: 301, location: '/accounting', set: ['h2=1; Path=/'] },
    }, ['/probe']);
    expect(cookiesSeen(pw, '/accounting')[0]).toBe('sb=1; h1=1; h2=1');
    expect(pw.map((r) => r.method + r.url)).toEqual(['POST/api/auth/login', 'GET/hop/1', 'GET/hop/2', 'GET/accounting', 'GET/accounting', 'GET/probe']);
    expect(mine).toEqual(pw);
  });

  it('a 307 keeps the POST', async () => {
    const { pw, mine } = await parity('localhost', { [LOGIN]: { status: 307, location: '/api/auth/login2' }, 'POST /api/auth/login2': { set: ['a=1; Path=/'] } }, ['/probe']);
    expect(pw[1]).toMatchObject({ method: 'POST', url: '/api/auth/login2' });
    expect(mine).toEqual(pw);
  });

  it.each([20, 21])('a chain of %i redirects ends as it does in Playwright', async (n) => {
    const routes: Record<string, Reply> = { [LOGIN]: { status: 302, location: '/hop/1' } };
    for (let i = 1; i <= n - 1; i++) routes[`GET /hop/${i}`] = { status: 302, location: `/hop/${i + 1}`, set: [`h${i}=1; Path=/`] };
    routes[`GET /hop/${n - 1}`] = { status: 302, location: '/done', set: [`h${n - 1}=1; Path=/`] };
    const { pw, mine, outcomes } = await parity('localhost', routes, ['/probe']);
    expect(outcomes[0]).toBe(n === 20 ? '200' : 'threw max redirects');
    expect(mine).toEqual(pw);
  });
});

describe('suiteProblems', () => {
  it('passes the verify company at localhost with production (Secure) cookies', async () => {
    const port = await startApp({ secure: true });
    expect(await suiteProblems(`http://localhost:${port}`, logins, 5_000)).toEqual([]);
  });

  it('THE INCIDENT: the same app at http://127.0.0.1 fails provisioning, naming the cookie cause and the address to use', async () => {
    const port = await startApp({ secure: true });
    const problems = await suiteProblems(`http://127.0.0.1:${port}`, logins, 5_000);
    expect(problems.join()).toContain('answered 401');
    expect(problems.join()).toContain(`http://localhost:${port}`);
  });

  it('a verify login whose session opens in the sandbox fails it', async () => {
    const port = await startApp({ secure: true, activeCompany: 'c2' });
    expect((await suiteProblems(`http://localhost:${port}`, logins, 5_000)).join()).toMatch(/active company is "0GP Golden Migration Sandbox"/);
  });

  it('an approver with a second company fails it', async () => {
    const port = await startApp({ secure: true, approverCompanies: 2 });
    expect((await suiteProblems(`http://localhost:${port}`, logins, 5_000)).join()).toMatch(/approver login's companies/);
  });

  it('a login the app refuses is a problem, not a crash', async () => {
    const port = await startApp({ secure: true });
    server!.removeAllListeners('request');
    server!.on('request', (_q, r) => { r.statusCode = 429; r.end('{}'); });
    expect((await suiteProblems(`http://localhost:${port}`, logins, 5_000)).join()).toMatch(/verify login .* answered 429/);
  });
});
