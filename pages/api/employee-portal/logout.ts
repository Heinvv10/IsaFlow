/** POST /api/employee-portal/logout: clears the employee portal session cookie (wave 6 SS). Same-origin JSON POST only
 * (review #1570 L1). No-store. */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withNoStore } from '@/lib/auth/withNoStore';
import { clearEmployeePortalCookie } from '@/lib/auth/employeePortalAuth';
import { withEmployeePortalSameOrigin } from '@/lib/auth/employeePortalSameOrigin';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  clearEmployeePortalCookie(res);
  return apiResponse.success(res, { signedIn: false });
}

export default withNoStore(withErrorHandler(withEmployeePortalSameOrigin(handler)));
