/**
 * Permission Modules API
 * GET — list all available module definitions (for UI dropdowns / grid headers).
 *       Any authenticated company member can call this.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany } from '@/lib/auth';
import { getPermissionModules } from '@/modules/accounting/services/permissionService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method!, ['GET']);
  }

  const modules = await getPermissionModules();
  return apiResponse.success(res, modules);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
