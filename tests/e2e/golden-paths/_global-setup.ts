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
import { assertGoldenTarget } from '../helpers/devTarget';
import { loginGolden } from './helpers/goldenLogin';
import { readGoldenSlot } from './helpers/goldenSlot';
import { approverFailure, approverProblems, suitePreconditionProblems, type SuiteGet } from './helpers/suitePreconditions';
import { budgetYearWarning, budgetYears, isVerifyLogin, startMonthOf } from './helpers/verifyCompany';

export const GOLDEN_STATE_FILE = 'tests/e2e/.auth/golden-session.json';

/** One GET in `ctx`'s session, as the shared checks take it (helpers/suitePreconditions.ts). */
const getIn = (ctx: APIRequestContext): SuiteGet => async (path) => {
  const res = await ctx.get(path);
  return { status: res.status(), body: await res.json().catch(() => null) };
};

/** The approver login (E2E_APPROVER_*, set by verify-deploy.sh from E2E_VERIFY_APPROVER_*) must reach the verify company and nothing else. */
async function verifyApprover(baseURL: string): Promise<void> {
  const email = process.env.E2E_APPROVER_EMAIL;
  const password = process.env.E2E_APPROVER_PASSWORD;
  if (!email || !password) return;
  const actx = await pwRequest.newContext({ baseURL });
  try {
    const login = await actx.post('/api/auth/login', { data: { email, password } });
    if (login.status() !== 200) throw new Error(`golden-paths: the approver login failed: ${login.status()}`);
    const problems = await approverProblems(getIn(actx), baseURL);
    if (problems.length > 0) throw new Error(approverFailure(problems, 're-run scripts/deploy/provision-verify-company.sh or fix the approver\'s memberships.'));
  } finally {
    await actx.dispose();
  }
}

/** Prints the budget-year WARNING (helpers/verifyCompany.ts budgetYearWarning) for the company the suite is in, its year start taken from the app. */
async function warnBudgetYear(ctx: APIRequestContext): Promise<void> {
  const data = async <T>(p: string): Promise<T | null> =>
    ((await ctx.get(p).then((r) => r.json()).catch(() => null)) as { data?: T } | null)?.data ?? null;
  const startMonth = startMonthOf(await data<{ year?: { startDate?: unknown } }>('/api/accounting/budgets?years_only=1'));
  if (startMonth === null) return; // the app did not say: no guess
  const today = new Date();
  const { current, next } = budgetYears(today, startMonth);
  const has = new Map<number, boolean>();
  for (const year of [current, next]) has.set(year, ((await data<{ items?: unknown[] }>(`/api/accounting/budget-versions?fiscalYear=${year}`))?.items?.length ?? 0) > 0);
  const warning = budgetYearWarning(today, (y) => has.get(y) === true, 60, startMonth);
  if (warning) process.stdout.write(`${warning}\n`);
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use?.baseURL;
  if (!baseURL) throw new Error('golden config must define use.baseURL');
  // Before any login. Only a deploy run may name a production colour, and only the one under deploy; every other run is
  // refused anything but dev and CI.
  assertGoldenTarget(baseURL);

  const ctx = await pwRequest.newContext({ baseURL });
  await loginGolden(ctx, readGoldenSlot(process.env));

  // The session first (a login whose cookie never comes back reads as an empty everything), then, as the verify user, the company
  // proof, then the chart's system accounts: one shared list (helpers/suitePreconditions.ts), which the verify provisioner's readiness
  // gate runs too. Dev Demo lacked the system accounts until 2026-07-05 (see the baseline doc).
  const verifyRun = !readGoldenSlot(process.env) && isVerifyLogin(process.env);
  const problems = await suitePreconditionProblems(getIn(ctx), { baseUrl: baseURL, verifyLogin: verifyRun });
  if (problems.length > 0) throw new Error(problems.join(' '));
  if (verifyRun) {
    process.stdout.write('golden-paths: verified: the active company is "Deploy Verification" (is_demo) and the verify login owns nothing else\n');
    await verifyApprover(baseURL);
    await warnBudgetYear(ctx);
  }

  mkdirSync(dirname(GOLDEN_STATE_FILE), { recursive: true });
  await ctx.storageState({ path: GOLDEN_STATE_FILE });
  await ctx.dispose();
}
