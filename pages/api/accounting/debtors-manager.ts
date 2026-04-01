/**
 * Debtors Manager API
 * GET /api/accounting/debtors-manager
 *
 * Query params:
 *   ?customerId=UUID      → returns DebtorInvoice[] for that customer
 *   ?daysOverdue=30       → filters overdue invoices to >= N days
 *   (no params)           → returns { summary, stats, overdueInvoices }
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  getDebtorsSummary,
  getDebtorDetail,
  getOverdueInvoices,
  getCollectionStats,
} from '@/modules/accounting/services/debtorsManagerService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyApiRequest;

  try {
    const { customerId, daysOverdue } = req.query;

    // Detail view — invoices for a single customer
    if (customerId) {
      const detail = await getDebtorDetail(companyId, String(customerId));
      return apiResponse.success(res, detail);
    }

    // Full dashboard — summary + stats + overdue list
    const minDays = daysOverdue ? Number(daysOverdue) : undefined;

    const [summary, stats, overdueInvoices] = await Promise.all([
      getDebtorsSummary(companyId),
      getCollectionStats(companyId),
      getOverdueInvoices(companyId, minDays),
    ]);

    return apiResponse.success(res, { summary, stats, overdueInvoices });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load debtors data';
    log.error('debtors-manager API error', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, message);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
