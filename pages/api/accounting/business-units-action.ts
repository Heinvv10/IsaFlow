/**
 * Business Units Action API
 * POST — update, toggle, delete. update and toggle go through the same plan
 * (code clash, defaults before a deactivation); one that changes nothing
 * succeeds. delete is refused, counted, while anything carries the BU.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import {
  applyUpdateBusinessUnit, BusinessUnitActionError, deleteBusinessUnit, planUpdateBusinessUnit, type BusinessUnitUpdate,
} from '@/modules/accounting/services/core/businessUnitService';

/** The form's fields: absent = unchanged, '' = clear (division / description). */
function text(data: Record<string, unknown>, key: string): string | undefined {
  return typeof data[key] === 'string' ? (data[key] as string) : undefined;
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method!, ['POST']);

  const { companyId } = req as CompanyAuthedRequest;
  const { action, id, ...data } = req.body;
  if (!action || !id) return apiResponse.badRequest(res, 'action and id required');

  try {
    const update = async (input: BusinessUnitUpdate) =>
      applyUpdateBusinessUnit(companyId, await planUpdateBusinessUnit(companyId, String(id), input));
    if (action === 'update') {
      const bu = await update({
        code: text(data, 'code'), name: text(data, 'name'),
        description: text(data, 'description'), division: text(data, 'division'),
      });
      return apiResponse.success(res, bu);
    }
    if (action === 'toggle') {
      await update({ isActive: data.isActive !== false });
      return apiResponse.success(res, { toggled: true });
    }
    if (action === 'delete') {
      await deleteBusinessUnit(companyId, String(id));
      return apiResponse.success(res, { deleted: true });
    }
    return apiResponse.badRequest(res, `Unknown action: ${action}`);
  } catch (err) {
    // The typed refusal is written for the operator; everything else stays generic.
    if (err instanceof BusinessUnitActionError) {
      log.warn('Business unit action refused', { action, id, reason: err.message }, 'accounting-api');
      return apiResponse.badRequest(res, err.message);
    }
    log.error('Business unit action failed', { action, id, error: err }, 'accounting-api');
    return apiResponse.badRequestFromError(res, err, 'Failed');
  }
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
