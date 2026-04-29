/**
 * POST /api/onboarding/complete
 * Marks onboarding as completed for the current user.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { setOnboardingDoneCookie } from '@/lib/auth/cookies';
import { sql } from '@/lib/neon';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method!, ['POST']);
  }

  const userId = (req as AuthenticatedNextApiRequest).user.id;

  await sql`UPDATE users SET onboarding_completed = true WHERE id = ${userId}`;

  setOnboardingDoneCookie(res);

  return apiResponse.success(res, { completed: true });
}

 
export default withAuth(withErrorHandler(handler));
