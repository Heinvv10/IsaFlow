// pages/api/accounting/afs-mapping/lines.ts
// GET  — list statement lines (optional ?section=balance_sheet|income_statement)
// POST — seed default taxonomy for company

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { apiResponse } from '@/lib/apiResponse';
import {
  getStatementLines,
  seedDefaultTaxonomy,
  type AfsLineSection,
} from '@/modules/accounting/services/afs/afsMappingService';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  const { companyId } = req;

  if (req.method === 'GET') {
    const section = req.query.section as AfsLineSection | undefined;
    if (section && section !== 'balance_sheet' && section !== 'income_statement') {
      return apiResponse.badRequest(res, 'section must be balance_sheet or income_statement');
    }
    const lines = await getStatementLines(companyId, section);
    return apiResponse.success(res, lines);
  }

  if (req.method === 'POST') {
    const result = await seedDefaultTaxonomy(companyId);
    return apiResponse.success(res, result, 'Default taxonomy seeded');
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
