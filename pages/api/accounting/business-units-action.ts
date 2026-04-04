/**
 * Business Units Action API
 * POST — update, toggle, delete
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { updateBusinessUnit, toggleBusinessUnit, deleteBusinessUnit } from '@/modules/accounting/services/businessUnitService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method!, ['POST']);

  const { companyId } = req as CompanyApiRequest;
  const { action, id, ...data } = req.body;
  if (!action || !id) return apiResponse.badRequest(res, 'action and id required');

  try {
    if (action === 'update') {
      const bu = await updateBusinessUnit(companyId, id, data);
      return apiResponse.success(res, bu);
    }
    if (action === 'toggle') {
      await toggleBusinessUnit(companyId, id, data.isActive ?? true);
      return apiResponse.success(res, { toggled: true });
    }
    if (action === 'delete') {
      await deleteBusinessUnit(companyId, id);
      return apiResponse.success(res, { deleted: true });
    }
    return apiResponse.badRequest(res, `Unknown action: ${action}`);
  } catch (err) {
    log.error('Business unit action failed', { action, id, error: err }, 'accounting-api');
    return apiResponse.badRequest(res, err instanceof Error ? err.message : 'Failed');
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
