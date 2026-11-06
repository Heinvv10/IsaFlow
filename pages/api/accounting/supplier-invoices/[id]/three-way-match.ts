/**
 * GET  /api/accounting/supplier-invoices/[id]/three-way-match
 *   The match as of now, judged from the live bill, PO and GRN. Reads only.
 *
 * POST /api/accounting/supplier-invoices/[id]/three-way-match
 *   Runs performThreeWayMatch, which stores the result on the bill, and returns the same shape.
 *
 * The response is `ThreeWayMatchState`, what `ThreeWayMatchPanel` renders.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { performThreeWayMatch } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { matchableInvoiceExists, readThreeWayMatchState } from '@/modules/accounting/services/ap/threeWayMatchState';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  const { companyId } = req;
  const invoiceId = req.query.id as string;

  if (!invoiceId) return apiResponse.badRequest(res, 'invoiceId is required');
  if (req.method !== 'GET' && req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET', 'POST']);
  }

  if (!(await matchableInvoiceExists(companyId, invoiceId))) return apiResponse.notFound(res, 'Supplier invoice', invoiceId);
  if (req.method === 'POST') {
    const result = await performThreeWayMatch(companyId, invoiceId);
    log.info('3-way match POST recomputed', { invoiceId, matchStatus: result.matchStatus }, 'three-way-match');
  }
  const state = await readThreeWayMatchState(companyId, invoiceId);
  return state ? apiResponse.success(res, state) : apiResponse.notFound(res, 'Supplier invoice', invoiceId);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0]))));
