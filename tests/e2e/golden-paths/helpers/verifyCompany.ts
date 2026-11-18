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
  if (real.length) problems.push(`the verify user belongs to company(ies) that are not is_demo: ${real.map((n) => `"${n}"`).join(', ')}`);
  return problems;
}
