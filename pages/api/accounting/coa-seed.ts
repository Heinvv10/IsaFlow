/**
 * POST /api/accounting/coa-seed
 * Seed a Chart of Accounts for the current company from a template.
 * Called by the onboarding wizard after company creation.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { seedChartOfAccountsFromTemplate, type CoaTemplate } from '@/modules/accounting/services/gl/chartOfAccountsService';

const VALID_TEMPLATES: CoaTemplate[] = ['isaflow_standard', 'xero_compatible', 'sage_compatible', 'blank'];

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const template = (req.body?.template ?? 'isaflow_standard') as CoaTemplate;

  if (!VALID_TEMPLATES.includes(template)) {
    return apiResponse.badRequest(res, `Invalid template. Valid: ${VALID_TEMPLATES.join(', ')}`);
  }

  await seedChartOfAccountsFromTemplate(companyId, template);
  return apiResponse.success(res, { seeded: true, template });
}

export default withAuth(withErrorHandler(withCsrf(handler)));
