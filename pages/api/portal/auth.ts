/**
 * Client Portal — Authentication API
 * POST — login with email/password
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { authenticatePortalUser } from '@/modules/accounting/services/portalService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method!, ['POST']);
  }

  const { email, password } = req.body;
  if (!email || !password) {
    return apiResponse.badRequest(res, 'email and password are required');
  }

  const user = await authenticatePortalUser(email, password);
  if (!user) {
    return apiResponse.unauthorized(res, 'Invalid email or password');
  }

  return apiResponse.success(res, { user });
}

export default withErrorHandler(handler);
