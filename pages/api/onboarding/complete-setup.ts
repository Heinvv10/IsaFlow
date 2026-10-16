/**
 * POST /api/onboarding/complete-setup
 * Finishes onboarding in one transaction: the company (with its entity type),
 * the owner membership, the chart of accounts from the chosen template, the
 * people (role from the entity), the documents, and users.onboarding_completed.
 * A failure anywhere leaves nothing behind; the cookies are only sent once the
 * transaction has committed (withAuth buffers the response until then).
 *
 * The same per-entity rules as the wizard (entityOnboardingRules) decide what
 * is required: a (Pty) Ltd cannot finish without its CIPC certificate, a sole
 * proprietor or partnership without each person's ID document.
 *
 * The old step-by-step endpoints (/api/accounting/companies, coa-seed,
 * company-directors, /api/onboarding/documents, /api/onboarding/complete) stay
 * for their other callers; the wizard uses only this one.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { setActiveCompanyCookie, setOnboardingDoneCookie } from '@/lib/auth/cookies';
import { withCsrf } from '@/lib/auth/withCsrf';
import { checkRateLimit } from '@/lib/rateLimit';
import { setupIssues } from '@/modules/onboarding/services/entityOnboardingRules';
import { parseSetupRequest, setupFactsOf } from '@/modules/onboarding/services/onboardingSetupPayload';
import { completeOnboardingSetup } from '@/modules/onboarding/services/onboardingSetupService';
import { isValidVatPeriod, isValidVatSystemType } from '../accounting/companies';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method!, ['POST']);
  }
  const userId = (req as AuthenticatedNextApiRequest).user.id;

  // Pentest H15/M22: the 50 MB body parser is rate-limited per user.
  if (!(await checkRateLimit(`onboarding-setup:${userId}`, { max: 10, windowSecs: 3600 }))) {
    return apiResponse.tooManyRequests(res);
  }

  const parsed = parseSetupRequest(req.body);
  if (!parsed.ok) return apiResponse.badRequest(res, parsed.error);
  const setup = parsed.value;

  if (!isValidVatPeriod(setup.company.vatPeriod)) {
    return apiResponse.badRequest(res, "vatPeriod must be 'monthly', 'bi-monthly' or 'none'");
  }
  if (!isValidVatSystemType(setup.company.vatSystemType)) {
    return apiResponse.badRequest(res, "vatSystemType must be 'invoice', 'payment' or 'none'");
  }
  const issues = setupIssues(setupFactsOf(setup));
  if (issues.length > 0) return apiResponse.badRequest(res, issues.join('. '), { issues });

  const outcome = await completeOnboardingSetup(setup, userId);

  // Land the user in the company they just set up, and stop the middleware
  // sending them back to /onboarding.
  setActiveCompanyCookie(res, outcome.companyId);
  setOnboardingDoneCookie(res);
  return apiResponse.success(res, outcome);
}

export default withAuth(withErrorHandler(withCsrf(handler)));

export const config = {
  api: { bodyParser: { sizeLimit: '50mb' } },
};
