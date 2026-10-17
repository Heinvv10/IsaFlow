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
 * This is the wizard's only write. The step-by-step endpoints it replaced
 * (/api/accounting/companies POST, coa-seed, company-directors) stay for
 * their other callers; /api/onboarding/complete only re-issues the cookie for
 * a user who has already finished.
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
import { OnboardingKeyConflictError, completeOnboardingSetup } from '@/modules/onboarding/services/onboardingSetupService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method!, ['POST']);
  }
  const userId = (req as AuthenticatedNextApiRequest).user.id;

  // A loose cap on every attempt, refused or not, so the parser and its file
  // checks cannot be driven in a loop; the tighter one below counts only
  // requests that passed validation.
  if (!(await checkRateLimit(`onboarding-setup-attempt:${userId}`, { max: 60, windowSecs: 3600 }))) {
    return apiResponse.tooManyRequests(res);
  }

  const parsed = parseSetupRequest(req.body);
  if (!parsed.ok) return apiResponse.badRequest(res, parsed.error);
  const setup = parsed.value;
  const issues = setupIssues(setupFactsOf(setup));
  if (issues.length > 0) return apiResponse.badRequest(res, issues.join('. '), { issues });

  // Counts only requests that passed validation, so a user fixing a refused
  // form is not locked out. Next has already parsed the body by now: its size
  // is bounded by bodyParser.sizeLimit below, not by this limit.
  if (!(await checkRateLimit(`onboarding-setup:${userId}`, { max: 10, windowSecs: 3600 }))) {
    return apiResponse.tooManyRequests(res);
  }

  let outcome;
  try {
    outcome = await completeOnboardingSetup(setup, userId);
  } catch (err) {
    if (err instanceof OnboardingKeyConflictError) {
      return apiResponse.conflict(res, 'This setup was already submitted for a company that is no longer active. Reload the page and start again.');
    }
    throw err;
  }

  // Land the user in the company they just set up, and stop the middleware
  // sending them back to /onboarding.
  setActiveCompanyCookie(res, outcome.companyId);
  setOnboardingDoneCookie(res);
  return apiResponse.success(res, outcome);
}

export default withAuth(withErrorHandler(withCsrf(handler)));

// 30 MB of files (MAX_TOTAL_UPLOAD_BYTES) is 40 MB as base64, plus the JSON around it.
export const config = {
  api: { bodyParser: { sizeLimit: '41mb' } },
};
