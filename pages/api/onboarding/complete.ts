/**
 * POST /api/onboarding/complete
 * Re-issues the onboarding-done cookie for a user who needs no wizard:
 *  - onboarding_completed = true (the cookie was lost: incognito, cleared);
 *  - onboarding_completed IS NULL (a legacy or invited user) AND a company_users
 *    row exists: the flag is set to true.
 * No users row, or NULL with no membership: 409. (withAuth already demands
 * both for the active company; this route does not rely on that.)
 * Refused (409) while the flag is false: that user finishes by submitting the
 * wizard (POST /api/onboarding/complete-setup), which sets it in the same
 * transaction as the company. Without this check any signed-in user could skip
 * the wizard and its required documents by calling this route.
 * Called by useOnboardingAuthGate for exactly the two allowed cases.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { setOnboardingDoneCookie } from '@/lib/auth/cookies';
import { withCsrf } from '@/lib/auth/withCsrf';
import { sql } from '@/lib/neon';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method!, ['POST']);
  }

  const userId = (req as AuthenticatedNextApiRequest).user.id;

  const rows = (await sql`SELECT onboarding_completed FROM users WHERE id = ${userId}`) as { onboarding_completed: boolean | null }[];
  if (rows.length === 0) {
    return apiResponse.conflict(res, 'Your profile is not set up yet. Sign out and sign in again.');
  }
  const flag = rows[0]!.onboarding_completed;
  if (flag === false) {
    return apiResponse.conflict(res, 'Onboarding is not finished yet. Complete the setup wizard to continue.');
  }
  if (flag === null) {
    // A legacy user counts as onboarded only by belonging to a company.
    const member = (await sql`SELECT 1 AS ok FROM company_users WHERE user_id = ${userId} LIMIT 1`) as unknown[];
    if (member.length === 0) {
      return apiResponse.conflict(res, 'Onboarding is not finished yet. Complete the setup wizard to continue.');
    }
    await sql`UPDATE users SET onboarding_completed = true WHERE id = ${userId} AND onboarding_completed IS NULL`;
  }

  setOnboardingDoneCookie(res);

  return apiResponse.success(res, { completed: true });
}

export default withAuth(withErrorHandler(withCsrf(handler)));
