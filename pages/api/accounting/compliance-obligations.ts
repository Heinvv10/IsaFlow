/**
 * Compliance Obligations API
 * GET — the active company's statutory obligation config (null = none configured)
 * PUT — upsert the config { vatEnabled, emp201Enabled, emp501Enabled,
 *       provisionalTaxEnabled, cipcEnabled, yearEndMonth, cipcAnniversaryMonth }
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import {
  getObligations,
  upsertObligations,
  validateObligations,
  type ComplianceObligations,
} from '@/modules/bureau/services/complianceObligationsService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    const config = await getObligations(companyId);
    return apiResponse.success(res, config);
  }

  if (req.method === 'PUT') {
    const body = req.body as Partial<ComplianceObligations> | undefined;
    if (!body || typeof body !== 'object') {
      return apiResponse.badRequest(res, 'Request body required');
    }
    const input: ComplianceObligations = {
      vatEnabled: Boolean(body.vatEnabled),
      emp201Enabled: Boolean(body.emp201Enabled),
      emp501Enabled: Boolean(body.emp501Enabled),
      provisionalTaxEnabled: Boolean(body.provisionalTaxEnabled),
      cipcEnabled: Boolean(body.cipcEnabled),
      yearEndMonth: Number(body.yearEndMonth ?? 2),
      cipcAnniversaryMonth:
        body.cipcAnniversaryMonth == null ? null : Number(body.cipcAnniversaryMonth),
    };
    const validationError = validateObligations(input);
    if (validationError) {
      return apiResponse.badRequest(res, validationError);
    }
    const saved = await upsertObligations(companyId, input);
    return apiResponse.success(res, saved, 'Compliance obligations saved');
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'PUT']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
