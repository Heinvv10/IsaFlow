/**
 * What the golden suite needs before any spec runs, checked ONE way by its global setup (Playwright's request context) and by the
 * verify provisioner's readiness gate (scripts/deploy/verifyCompany/suiteReadiness.ts, a client that keeps cookies as Playwright does),
 * so a company the provisioner passes is one the suite starts in. Pure: the caller hands in its own GET.
 *
 * Order: the session (was the login's cookie sent back at all?), then, for the verify login, the company proof, then the chart's
 * system accounts. Incident 2026-11-18: verify-deploy.sh run by hand against http://127.0.0.1:3101 (nginx) logged in (200), and every
 * later GET answered 401: a production build sets its cookies `Secure`, and Playwright sends a Secure cookie over plain http only to
 * `localhost` / `*.localhost`, never to an IP address. The old precondition ignored the status and reported the 401s as "company has
 * no system account for [all six]", and the company proof, which ran after it, never ran. The deploy's own verifications use
 * http://localhost:<port> and were never affected.
 */
import { approverCompanyProblems, verifyCompanyProblems, type UserCompany } from './verifyCompany';

export interface SuiteResponse { status: number; body: unknown }
/** One GET in the suite's session: the status and the parsed JSON body (null when it was not JSON). */
export type SuiteGet = (path: string) => Promise<SuiteResponse>;

export const USER_COMPANIES = '/api/accounting/companies?action=user-companies';
/** The system-account roles GL-on-approve resolves (receivable, revenue and output VAT for AR; payable, expense and input VAT for AP). */
export const SYSTEM_ACCOUNT_SUBTYPES = ['receivable', 'default_revenue', 'vat_output', 'payable', 'vat_input', 'default_expense'] as const;

/** playwright-core's own test (server/network.js isLocalHostname): the hosts it treats as secure over plain http. */
export const isLocalHostname = (hostname: string): boolean => hostname === 'localhost' || hostname.endsWith('.localhost');

/** Whether the suite's client sends a `Secure` cookie to `url`: over https, or over plain http to localhost only. */
export function sendsSecureCookies(url: string): boolean {
  const u = new URL(url);
  return u.protocol === 'https:' || isLocalHostname(u.hostname);
}

/** The same url with its host made `localhost` (what to use instead of 127.0.0.1). */
const asLocalhost = (url: string): string => { const u = new URL(url); u.hostname = 'localhost'; return u.origin; };

/**
 * The first authenticated GET after a 200 login, judged. 401 means the app did not see the session: at an address the client keeps
 * Secure cookies from, that is the cause, and the message says which address to use.
 */
export function sessionProblem(baseUrl: string, status: number, who = 'the suite\'s login'): string | null {
  if (status === 200) return null;
  const head = `${who} succeeded but ${USER_COMPANIES} then answered ${status}`;
  if (status === 401 && !sendsSecureCookies(baseUrl)) {
    return `${head}: the session cookie never came back. A production build sets its cookies Secure, and the suite's client (Playwright) `
      + `sends a Secure cookie over plain http only to localhost, not to ${new URL(baseUrl).hostname}. Run against ${asLocalhost(baseUrl)} instead (or https)`;
  }
  return `${head}: the app refused the session`;
}

const dataOf = <T>(body: unknown): T | null => ((body as { data?: T } | null)?.data ?? null);

/**
 * Every reason the suite would not start in this session; empty when it would. `verifyLogin`: the post-deploy run as the dedicated
 * verify user, whose company is proved (helpers/verifyCompany.ts) before anything is read from it.
 */
export async function suitePreconditionProblems(get: SuiteGet, o: { baseUrl: string; verifyLogin: boolean }): Promise<string[]> {
  const uc = await get(USER_COMPANIES);
  const session = sessionProblem(o.baseUrl, uc.status);
  if (session) return [`golden-paths: ${session}. No spec runs.`];
  if (o.verifyLogin) {
    const data = dataOf<{ items?: UserCompany[]; activeCompanyId?: string }>(uc.body);
    const wrong = verifyCompanyProblems(data?.items ?? [], String(data?.activeCompanyId ?? ''));
    if (wrong.length) {
      return [`golden-paths: the verify login is not in the Deploy Verification company: ${wrong.join('; ')}. `
        + 'No spec runs: they would write to the wrong company. Re-run scripts/deploy/provision-verify-company.sh, or fix the login\'s memberships.'];
    }
  }
  // GL-on-approve needs the company's system-account mappings (the resolver requires is_system_account as well as the subtype).
  const missing: string[] = [];
  const refused: string[] = [];
  for (const subtype of SYSTEM_ACCOUNT_SUBTYPES) {
    const r = await get(`/api/accounting/chart-of-accounts?subtype=${subtype}`);
    if (r.status !== 200) { refused.push(`${subtype} (${r.status})`); continue; }
    const accounts = dataOf<unknown[]>(r.body);
    if (!(Array.isArray(accounts) && accounts.some((a) => (a as { isSystemAccount?: unknown } | null)?.isSystemAccount === true))) missing.push(subtype);
  }
  const problems: string[] = [];
  if (refused.length) problems.push(`golden-paths precondition failed: the chart of accounts could not be read for [${refused.join(', ')}]`);
  if (missing.length) {
    problems.push(`golden-paths precondition failed: company has no system account for [${missing.join(', ')}]. `
      + 'Set account_subtype + is_system_account on the chart of accounts (mirror prod Demo: 1120 receivable, 4100 default_revenue, 2120 vat_output).');
  }
  return problems;
}

/** The approver login (logged in on its own session) must reach the Deploy Verification company and nothing else. */
export async function approverProblems(get: SuiteGet, baseUrl: string): Promise<string[]> {
  const res = await get(USER_COMPANIES);
  const session = sessionProblem(baseUrl, res.status, 'the approver\'s login');
  if (session) return [`golden-paths: ${session}.`];
  return approverCompanyProblems(dataOf<{ items?: UserCompany[] }>(res.body)?.items ?? []).map((p) => `golden-paths: ${p}`);
}
