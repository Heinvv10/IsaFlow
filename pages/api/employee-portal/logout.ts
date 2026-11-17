/** POST /api/employee-portal/logout: clears the employee portal session cookie (wave 6 SS). No-store. */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withNoStore } from '@/lib/auth/withNoStore';
import { clearEmployeePortalCookie } from '@/lib/auth/employeePortalAuth';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  clearEmployeePortalCookie(res);
  return apiResponse.success(res, { signedIn: false });
}

export default withNoStore(withErrorHandler(handler));
