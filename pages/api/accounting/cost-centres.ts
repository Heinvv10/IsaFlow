/**
 * Cost Centres API
 * GET  — list all cost centres
 * POST — create a new cost centre
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { getCostCentres, type CcType } from '@/modules/accounting/services/core/costCentreService';
import {
  applyCreateDimensionCostCentre, listDimensionCostCentres, planCreateDimensionCostCentre,
} from '@/modules/accounting/services/gl/dimensions/dimensionMasterService';
import { isDimensionRefusal } from '@/modules/accounting/services/gl/dimensions/dimensionTypes';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;

  if (req.method === 'GET') {
    const activeOnly = req.query.active === 'true';
    const ccType = req.query.cc_type as CcType | undefined;
    // The master page: parent, derived FNO and aliases on every row.
    if (req.query.detail === 'dimensions') {
      const items = await listDimensionCostCentres(companyId, {
        ccType: ccType === 'cc1' || ccType === 'cc2' ? ccType : undefined, includeInactive: !activeOnly,
      });
      return apiResponse.success(res, { items });
    }
    const items = await getCostCentres(companyId, activeOnly, ccType);
    return apiResponse.success(res, { items });
  }

  if (req.method === 'POST') {
    const { code, name, description, department, ccType, parent, aliases } = req.body;
    if (!code || !name) return apiResponse.badRequest(res, 'code and name are required');
    try {
      // The same ladder and alias rules as the MCP create_cost_centre.
      const plan = await planCreateDimensionCostCentre(companyId, {
        code: String(code), name: String(name), ccType: ccType === 'cc2' ? 'cc2' : 'cc1',
        parent: typeof parent === 'string' && parent.trim() ? parent : undefined,
        aliases: Array.isArray(aliases) ? aliases.filter((a: unknown): a is string => typeof a === 'string') : [],
        description: typeof description === 'string' ? description : undefined,
        department: typeof department === 'string' ? department : undefined,
      });
      const created = await applyCreateDimensionCostCentre(companyId, plan, userId);
      return apiResponse.success(res, { id: created.id, code: plan.input.code, fnoCode: plan.fnoCode, warnings: plan.warnings });
    } catch (err) {
      if (isDimensionRefusal(err)) return apiResponse.badRequest(res, err.message);
      log.error('Failed to create cost centre', { error: err }, 'accounting-api');
      return apiResponse.badRequestFromError(res, err, 'Failed');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
