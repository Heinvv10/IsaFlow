// The golden suite's start-up checks (helpers/suitePreconditions.ts), shared by its global setup and the verify provisioner's gate.
// Incident 2026-11-18: run by hand against http://127.0.0.1:3101, the suite logged in (200) and every later GET answered 401 (the
// production app's cookies are Secure; Playwright sends those over plain http only to localhost). The precondition read the 401s
// as "company has no system account for [all six]". These pin: a refused session is named as one, with the cause; the company
// proof comes before the chart; a refused chart read is never reported as missing accounts.
import { describe, expect, it } from 'vitest';
import {
  SYSTEM_ACCOUNT_SUBTYPES, USER_COMPANIES, approverProblems, isLocalHostname, sendsSecureCookies, sessionProblem, suitePreconditionProblems,
  type SuiteGet,
} from '../../e2e/golden-paths/helpers/suitePreconditions';

const home = { companyId: 'c1', companyName: 'Deploy Verification', isDemo: true };
const sandbox = { companyId: 'c2', companyName: '0GP Golden Migration Sandbox', isDemo: true };
const sysAccount = { id: 'a', isSystemAccount: true };

/** An app that answers every GET with `over[path]`, or user-companies as the verify user in its company and a full chart. */
function app(over: Record<string, { status: number; body: unknown }> = {}): { get: SuiteGet; asked: string[] } {
  const asked: string[] = [];
  const get: SuiteGet = async (p) => {
    asked.push(p);
    if (p in over) return over[p]!;
    if (p === USER_COMPANIES) return { status: 200, body: { success: true, data: { items: [home, sandbox], activeCompanyId: 'c1' } } };
    if (p.startsWith('/api/accounting/chart-of-accounts?subtype=')) return { status: 200, body: { success: true, data: [sysAccount] } };
    throw new Error(`unexpected ${p}`);
  };
  return { get, asked };
}
const refusedEverywhere = (status: number): SuiteGet => async () => ({ status, body: { success: false, error: { code: 'UNAUTHORIZED' } } });

describe('isLocalHostname / sendsSecureCookies: the suite client\'s rule (playwright-core isLocalHostname)', () => {
  it('localhost and *.localhost only; never an IP address', () => {
    expect(isLocalHostname('localhost')).toBe(true);
    expect(isLocalHostname('app.localhost')).toBe(true);
    expect(isLocalHostname('127.0.0.1')).toBe(false);
    expect(isLocalHostname('[::1]')).toBe(false);
  });
  it('https anywhere, plain http only to localhost', () => {
    expect(sendsSecureCookies('https://app.isaflow.co.za')).toBe(true);
    expect(sendsSecureCookies('http://localhost:3101')).toBe(true);
    expect(sendsSecureCookies('http://127.0.0.1:3101')).toBe(false);
  });
});

describe('sessionProblem', () => {
  it('is null for a session the app accepted', () => {
    expect(sessionProblem('http://127.0.0.1:3101', 200)).toBeNull();
  });
  it('a 401 at an address the client withholds Secure cookies from names the cause and the address to use', () => {
    const msg = sessionProblem('http://127.0.0.1:3101', 401)!;
    expect(msg).toContain('answered 401');
    expect(msg).toContain('Secure');
    expect(msg).toContain('http://localhost:3101');
  });
  it('a 401 at localhost says the session was refused, without blaming the address', () => {
    const msg = sessionProblem('http://localhost:3101', 401)!;
    expect(msg).toContain('answered 401');
    expect(msg).not.toContain('Secure');
  });
});

describe('suitePreconditionProblems', () => {
  it('is empty for the verify user in its company with all six system accounts', async () => {
    const a = app();
    expect(await suitePreconditionProblems(a.get, { baseUrl: 'http://localhost:1', verifyLogin: true })).toEqual([]);
    expect(a.asked).toEqual([USER_COMPANIES, ...SYSTEM_ACCOUNT_SUBTYPES.map((s) => `/api/accounting/chart-of-accounts?subtype=${s}`)]);
  });

  it('THE INCIDENT: every GET refused (401) at 127.0.0.1 is one session problem naming the cookie cause, never "no system account"', async () => {
    const problems = await suitePreconditionProblems(refusedEverywhere(401), { baseUrl: 'http://127.0.0.1:3101', verifyLogin: true });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('http://localhost:3101');
    expect(problems.join()).not.toMatch(/system account/);
  });

  it('the company proof runs BEFORE the chart: a session in the wrong company reports the company, not its chart', async () => {
    const a = app({ [USER_COMPANIES]: { status: 200, body: { data: { items: [home, sandbox], activeCompanyId: 'c2' } } } });
    const problems = await suitePreconditionProblems(a.get, { baseUrl: 'http://localhost:1', verifyLogin: true });
    expect(problems.join()).toMatch(/not in the Deploy Verification company: the active company is "0GP Golden Migration Sandbox"/);
    expect(a.asked).toEqual([USER_COMPANIES]);
  });

  it('without the verify login (Demo, a CI slot) the company is not judged', async () => {
    const a = app({ [USER_COMPANIES]: { status: 200, body: { data: { items: [{ ...home, companyName: 'Demo Company', isDemo: false }], activeCompanyId: 'c1' } } } });
    expect(await suitePreconditionProblems(a.get, { baseUrl: 'http://localhost:1', verifyLogin: false })).toEqual([]);
  });

  it('a chart read that is refused is reported with its status, not as a missing account', async () => {
    const a = app({ '/api/accounting/chart-of-accounts?subtype=payable': { status: 500, body: null } });
    const msg = (await suitePreconditionProblems(a.get, { baseUrl: 'http://localhost:1', verifyLogin: true })).join();
    expect(msg).toContain('payable (500)');
    expect(msg).not.toMatch(/no system account/);
  });

  it('a subtype with no account, or one not flagged is_system_account, is missing (the resolver needs both)', async () => {
    const a = app({
      '/api/accounting/chart-of-accounts?subtype=vat_input': { status: 200, body: { data: [] } },
      '/api/accounting/chart-of-accounts?subtype=receivable': { status: 200, body: { data: [{ id: 'x', isSystemAccount: false }] } },
    });
    const msg = (await suitePreconditionProblems(a.get, { baseUrl: 'http://localhost:1', verifyLogin: true })).join();
    expect(msg).toContain('company has no system account for [receivable, vat_input]');
  });
});

describe('approverProblems', () => {
  it('is empty for an approver in exactly the verify company', async () => {
    expect(await approverProblems(app({ [USER_COMPANIES]: { status: 200, body: { data: { items: [home] } } } }).get, 'http://localhost:1')).toEqual([]);
  });
  it('a refused session is named as such (it used to read as "the approver\'s companies are []")', async () => {
    const msg = (await approverProblems(refusedEverywhere(401), 'http://127.0.0.1:3101')).join();
    expect(msg).toContain('the approver');
    expect(msg).toContain('http://localhost:3101');
    expect(msg).not.toContain('must be exactly');
  });
  it('another membership fails', async () => {
    expect((await approverProblems(app({ [USER_COMPANIES]: { status: 200, body: { data: { items: [home, sandbox] } } } }).get, 'http://localhost:1')).join()).toMatch(/must be exactly/);
  });
});
