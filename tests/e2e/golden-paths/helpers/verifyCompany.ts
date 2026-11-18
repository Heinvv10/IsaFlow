/**
 * The post-deploy suite's own proof that it is where it should be. When the suite logs in as the dedicated verify user
 * (scripts/verify-deploy.sh sets E2E_ADMIN_* to it), the email alone proves nothing: a wrong or renamed company, or a user
 * who has been given a real company, would put the specs' writes (and the 0GP fixtures) somewhere that matters. So the
 * suite reads the user's companies and fails unless the active one is "Deploy Verification" and is_demo, and the user owns
 * no company that is not is_demo.
 */
import { VERIFY_COMPANY_NAME, VERIFY_LOGIN } from '../../../../scripts/deploy/verifyCompany/identity';

export interface UserCompany { companyId: string; companyName: string; isDemo?: boolean }

/** Whether `env` makes the suite the verify user. */
export const isVerifyLogin = (env: Record<string, string | undefined>): boolean =>
  (env.E2E_ADMIN_EMAIL ?? '').trim().toLowerCase() === VERIFY_LOGIN.email;

/** @returns one message per way the user's companies are wrong; empty when the suite is in the verify company. */
export function verifyCompanyProblems(items: UserCompany[], activeCompanyId: string): string[] {
  const problems: string[] = [];
  const active = items.find((c) => c.companyId === activeCompanyId);
  if (!active) problems.push(`the session's active company (${activeCompanyId || 'none'}) is not one of the user's companies`);
  else if (active.companyName !== VERIFY_COMPANY_NAME) problems.push(`the active company is "${active.companyName}", not "${VERIFY_COMPANY_NAME}"`);
  else if (active.isDemo !== true) problems.push(`the active company "${active.companyName}" is not flagged is_demo`);
  const real = items.filter((c) => c.isDemo !== true).map((c) => c.companyName);
  if (real.length) {
    problems.push(`the verify user belongs to company(ies) that are not is_demo: ${real.map((n) => `"${n}"`).join(', ')}. `
      + 'Either a spec this run executes created it (it is not in scripts/deploy/verifyCompany/sandboxes.ts, which tests/unit/ci/verifyCompanySandboxCensus.test.ts keeps equal to the specs production verify runs: '
      + 'add the sandbox there or mark the spec // golden:dev-only), or the login was given a real membership by hand');
  }
  return problems;
}

/** The approver login must belong to the Deploy Verification company and nothing else. */
export function approverCompanyProblems(items: UserCompany[]): string[] {
  const names = items.map((c) => c.companyName);
  if (names.length === 1 && names[0] === VERIFY_COMPANY_NAME && items[0]!.isDemo === true) return [];
  return [`the approver login's companies are [${names.map((n) => `"${n}"`).join(', ') || 'none'}]; they must be exactly ["${VERIFY_COMPANY_NAME}"] (is_demo)`];
}

const DAY = 86_400_000;
/** The budget year label (calendar year it ends in) and the first day of the next one, for a March financial year. */
export function budgetYears(today: Date): { current: number; next: number; nextStarts: Date } {
  const y = today.getUTCFullYear();
  const current = today.getUTCMonth() >= 2 ? y + 1 : y;
  return { current, next: current + 1, nextStarts: new Date(Date.UTC(current, 2, 1)) };
}

/**
 * A loud line when the budget specs are about to lose their year: the next budget year starts within `windowDays` and has no
 * budget version yet, or the current year has none already. Re-running the provisioner (it tops up by year) is the cure.
 * @param hasVersion whether the verify company holds a budget version for that year label
 */
export function budgetYearWarning(today: Date, hasVersion: (year: number) => boolean, windowDays = 60): string | null {
  const { current, next, nextStarts } = budgetYears(today);
  const remedy = 'run scripts/deploy/provision-verify-company.sh (it adds the missing year\'s version); the budget specs skip otherwise and the gate fails';
  if (!hasVersion(current)) return `WARNING: the Deploy Verification company has no budget version for FY${current}, the current budget year: ${remedy}`;
  const days = Math.ceil((nextStarts.getTime() - today.getTime()) / DAY);
  if (!hasVersion(next) && days <= windowDays) return `WARNING: FY${next} starts in ${days} day(s) and the Deploy Verification company has no budget version for it: ${remedy}`;
  return null;
}
