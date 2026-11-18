// The verify provisioner's last gate: log in through the app as the suite will (verify login AND approver) and run the suite's own
// start-up checks (helpers/suitePreconditions.ts). Its client must keep cookies the way the suite's client does, or the gate passes a
// run the suite then fails: the 2026-11-18 incident (Secure cookies, http://127.0.0.1:3101). A local server plays the app; its
// cookie flags are the app's own (src/lib/auth/cookies.ts, production: HttpOnly; SameSite=Lax; Secure).
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
