/**
 * GET  /api/accounting/supplier-expectations         — list all expectations
 * GET  /api/accounting/supplier-expectations?supplierId=<id> — single
 * POST /api/accounting/supplier-expectations?action=recompute
 *      body: { supplierId?: string }
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import {
  listExpectations,
  getExpectation,
  recomputeForSupplier,
  recomputeAllForCompany,
} from '@/modules/accounting/services/capture/expectationEngineService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  // ── GET ──────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const { supplierId } = req.query as { supplierId?: string };

    if (supplierId) {
      const expectation = await getExpectation(companyId, supplierId);
      if (!expectation) return apiResponse.notFound(res, 'SupplierExpectation', supplierId);
      return apiResponse.success(res, expectation);
    }

    const expectations = await listExpectations(companyId);
    return apiResponse.success(res, expectations);
  }

  // ── POST /recompute ──────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const { action } = req.query as { action?: string };
    if (action !== 'recompute') {
      return apiResponse.badRequest(res, 'Unknown action. Use ?action=recompute');
    }

    const { supplierId } = (req.body ?? {}) as { supplierId?: string };

    if (supplierId) {
      log.info('Recomputing expectation for supplier', { companyId, supplierId }, 'supplier-expectations');
      const expectation = await recomputeForSupplier(companyId, supplierId);
      return apiResponse.success(res, expectation);
    }

    log.info('Recomputing all expectations for company', { companyId }, 'supplier-expectations');
    const result = await recomputeAllForCompany(companyId);
    return apiResponse.success(res, result);
  }

  return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0]))));
