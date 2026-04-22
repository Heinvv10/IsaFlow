/**
 * GET /api/accounting/bank-statements/[id]
 * Returns a single bank_statement_imports record including rows + warnings.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { getImport } from '@/modules/accounting/services/bank/bankStatementOcrService';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET']);

  const { companyId } = req;
  const { id } = req.query as { id: string };

  const imp = await getImport(companyId, id);
  if (!imp) return apiResponse.notFound(res, 'Bank statement import not found');

  return apiResponse.success(res, imp);
}

export default withAuth(withErrorHandler(handler as Parameters<typeof withAuth>[0]));
