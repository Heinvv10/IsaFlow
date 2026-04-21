// pages/api/accounting/vat-reconciliation.ts
// GET — VAT reconciliation: GL vs invoices vs submitted returns
// Query: ?from=YYYY-MM-DD&to=YYYY-MM-DD or ?multi_year=3

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { apiResponse } from '@/lib/apiResponse';
import {
  getVatReconciliation,
  getVatMultiYearSummary,
} from '@/modules/accounting/services/reports/vatReconciliationService';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);

  const { companyId } = req;

  // Multi-year summary mode
  if (req.query.multi_year) {
    const years = Math.min(Math.max(Number(req.query.multi_year) || 3, 1), 10);
    const summary = await getVatMultiYearSummary(companyId, years);
    return apiResponse.success(res, { type: 'multi_year', years, summary });
  }

  // Monthly reconciliation mode
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;

  if (!from || !to) {
    return apiResponse.badRequest(res, 'from and to dates are required (YYYY-MM-DD), or use ?multi_year=N');
  }

  const recon = await getVatReconciliation(companyId, from, to);
  return apiResponse.success(res, { type: 'reconciliation', ...recon });
}

export default withAuth(withErrorHandler(withWriteAccess(handler)));
