// pages/api/accounting/afs-mapping/trial-balance.ts
// GET — trial balance reorganized by AFS line codes
// Query: ?fiscal_period_id=xxx&prior_period_id=yyy (optional)

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { apiResponse } from '@/lib/apiResponse';
import { getMappedTrialBalance } from '@/modules/accounting/services/afs/afsMappingService';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);

  const { companyId } = req;
  const fiscalPeriodId = req.query.fiscal_period_id as string;
  const priorPeriodId = req.query.prior_period_id as string | undefined;

  if (!fiscalPeriodId) {
    return apiResponse.badRequest(res, 'fiscal_period_id is required');
  }

  const data = await getMappedTrialBalance(companyId, fiscalPeriodId, priorPeriodId);

  const bsLines = data.filter((l) => l.section === 'balance_sheet');
  const isLines = data.filter((l) => l.section === 'income_statement');

  return apiResponse.success(res, {
    fiscalPeriodId,
    priorPeriodId: priorPeriodId ?? null,
    balanceSheet: bsLines,
    incomeStatement: isLines,
    summary: {
      totalBsLines: bsLines.length,
      totalIsLines: isLines.length,
      bsLinesWithData: bsLines.filter((l) => l.currentAmount !== 0).length,
      isLinesWithData: isLines.filter((l) => l.currentAmount !== 0).length,
    },
  });
}

export default withAuth(withErrorHandler(withWriteAccess(handler)));
