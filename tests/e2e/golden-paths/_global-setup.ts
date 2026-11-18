/**
 * Golden-paths global setup — logs in ONCE per suite run and saves the
 * storage state (session + CSRF cookies) for every spec to reuse.
 *
 * One login per run matters: /api/auth/login is rate-limited to 10 attempts
 * per email per 15 minutes. Eleven specs logging in individually would spend
 * the whole window on a single run (and break post-deploy verification
 * against production).
 *
 * In CI the job sets GOLDEN_COMPANY_ID/_USER_EMAIL/_USER_PASSWORD (see
 * helpers/goldenSlot.ts) and the login is the slot user's, switched into the
 * slot company. Without them nothing changes: E2E_ADMIN_*, that user's default
 * company. In the post-deploy run scripts/verify-deploy.sh points E2E_ADMIN_* at
 * the dedicated verify user (E2E_VERIFY_*), whose only company is the hidden
 * Deploy Verification company, so no spec writes to Demo; without that login it
 * is the Demo admin and says so.
 */
import { request as pwRequest, type APIRequestContext, type FullConfig } from '@playwright/test';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { loginGolden } from './helpers/goldenLogin';
import { readGoldenSlot } from './helpers/goldenSlot';
import { approverCompanyProblems, budgetYearWarning, budgetYears, isVerifyLogin, startMonthOf, verifyCompanyProblems, type UserCompany } from './helpers/verifyCompany';

export const GOLDEN_STATE_FILE = 'tests/e2e/.auth/golden-session.json';

/** The approver login (E2E_APPROVER_*, set by verify-deploy.sh from E2E_VERIFY_APPROVER_*) must reach the verify company and nothing else. */
async function verifyApprover(baseURL: string): Promise<void> {
  const email = process.env.E2E_APPROVER_EMAIL;
  const password = process.env.E2E_APPROVER_PASSWORD;
  if (!email || !password) return;
  const actx = await pwRequest.newContext({ baseURL });
  try {
    const login = await actx.post('/api/auth/login', { data: { email, password } });
    if (login.status() !== 200) throw new Error(`golden-paths: the approver login failed: ${login.status()}`);
    const res = await actx.get('/api/accounting/companies?action=user-companies');
    const body = (await res.json().catch(() => null)) as { data?: { items?: UserCompany[] } } | null;
    const problems = approverCompanyProblems(body?.data?.items ?? []);
    if (problems.length > 0) throw new Error(`golden-paths: ${problems.join('; ')}. No spec runs: re-run scripts/deploy/provision-verify-company.sh or fix the approver's memberships.`);
  } finally {
    await actx.dispose();
  }
}

/** Prints the budget-year WARNING (helpers/verifyCompany.ts budgetYearWarning) for the company the suite is in, its year start taken from the app. */
async function warnBudgetYear(ctx: APIRequestContext): Promise<void> {
  const json = async (p: string) => (await ctx.get(p).then((r) => r.json()).catch(() => null)) as { data?: any } | null;
  const startMonth = startMonthOf((await json('/api/accounting/budgets?years_only=1'))?.data);
  if (startMonth === null) return; // the app did not say: no guess
  const today = new Date();
  const { current, next } = budgetYears(today, startMonth);
  const has = new Map<number, boolean>();
  for (const year of [current, next]) has.set(year, ((await json(`/api/accounting/budget-versions?fiscalYear=${year}`))?.data?.items?.length ?? 0) > 0);
  const warning = budgetYearWarning(today, (y) => has.get(y) === true, 60, startMonth);
  if (warning) process.stdout.write(`${warning}\n`);
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use?.baseURL;
  if (!baseURL) throw new Error('golden config must define use.baseURL');

  const ctx = await pwRequest.newContext({ baseURL });
  await loginGolden(ctx, readGoldenSlot(process.env));

  // Precondition: GL-on-approve needs the company's system-account mappings.
  // Fail HERE with an actionable message instead of letting spec b/c/e fail
  // mysteriously on an environment whose Demo company is missing them (dev
  // Demo was, until 2026-07-05 — see the baseline doc).
  const missing: string[] = [];
  for (const subtype of [
    'receivable',
    'default_revenue',
    'vat_output',
    'payable',
    'vat_input',
    'default_expense',
  ]) {
    const res2 = await ctx.get(`/api/accounting/chart-of-accounts?subtype=${subtype}`);
    const body = await res2.json().catch(() => null);
    const accounts = body?.data ?? [];
    // The resolver requires is_system_account=true as well as the subtype.
    const ok =
      Array.isArray(accounts) && accounts.some((a: any) => a.isSystemAccount === true);
    if (!ok) missing.push(subtype);
  }
  if (missing.length > 0) {
    throw new Error(
      `golden-paths precondition failed: company has no system account for [${missing.join(', ')}]. ` +
        `Set account_subtype + is_system_account on the chart of accounts (mirror prod Demo: 1120 receivable, 4100 default_revenue, 2120 vat_output).`,
    );
  }

  // The post-deploy run as the dedicated verify user: prove the company, never trust the email (see helpers/verifyCompany.ts).
  if (!readGoldenSlot(process.env) && isVerifyLogin(process.env)) {
    const res3 = await ctx.get('/api/accounting/companies?action=user-companies');
    const body3 = (await res3.json().catch(() => null)) as { data?: { items?: UserCompany[]; activeCompanyId?: string } } | null;
    const problems = verifyCompanyProblems(body3?.data?.items ?? [], String(body3?.data?.activeCompanyId ?? ''));
    if (problems.length > 0) {
      throw new Error(`golden-paths: the verify login is not in the Deploy Verification company: ${problems.join('; ')}. `
        + 'No spec runs: they would write to the wrong company. Re-run scripts/deploy/provision-verify-company.sh, or fix the login\'s memberships.');
    }
    process.stdout.write('golden-paths: verified: the active company is "Deploy Verification" (is_demo) and the verify login owns nothing else\n');
    await verifyApprover(baseURL);
    await warnBudgetYear(ctx);
  }

  mkdirSync(dirname(GOLDEN_STATE_FILE), { recursive: true });
  await ctx.storageState({ path: GOLDEN_STATE_FILE });
  await ctx.dispose();
}
