/**
 * POST /api/onboarding/complete
 * Marks onboarding as completed for the current user.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method!, ['POST']);
  }

  const userId = (req as AuthenticatedNextApiRequest).user.id;

  await sql`UPDATE users SET onboarding_completed = true WHERE id = ${userId}`;

  const isProd = process.env.NODE_ENV === 'production';
  const secureSuffix = isProd ? '; Secure' : '';
  const domainSuffix = isProd ? '; Domain=.isaflow.co.za' : '';
  res.setHeader(
    'Set-Cookie',
    `ff_onboarding_done=1; Path=/; Max-Age=31536000; SameSite=Lax${secureSuffix}${domainSuffix}`
  );

  return apiResponse.success(res, { completed: true });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withAuth(withErrorHandler(handler));
