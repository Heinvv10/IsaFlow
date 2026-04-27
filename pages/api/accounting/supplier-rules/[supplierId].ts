/**
 * GET    /api/accounting/supplier-rules/[supplierId] — get rule for supplier
 * PATCH  /api/accounting/supplier-rules/[supplierId] — update rule
 * DELETE /api/accounting/supplier-rules/[supplierId] — remove rule
 *
 * supplierId is the supplier FK (matches UNIQUE constraint on supplier_coding_rules).
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import {
  getRule,
  upsertRule,
  deleteRule,
} from '@/modules/accounting/services/capture/supplierRulesService';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  const { companyId } = req;
  const userId = req.user?.id ?? '';
  const supplierId = req.query.supplierId as string;

  if (!supplierId) return apiResponse.badRequest(res, 'supplierId param missing');

  if (req.method === 'GET') {
    const rule = await getRule(companyId, supplierId);
    if (!rule) return apiResponse.notFound(res, 'Supplier coding rule', supplierId);
    return apiResponse.success(res, rule);
  }

  if (req.method === 'PATCH') {
    const patch = req.body as Record<string, unknown>;
    const rule = await upsertRule(companyId, supplierId, patch, userId);
    log.info('Supplier rule patched via API', { companyId, supplierId }, 'supplier-rules-api');
    return apiResponse.success(res, rule);
  }

  if (req.method === 'DELETE') {
    const existing = await getRule(companyId, supplierId);
    if (!existing) return apiResponse.notFound(res, 'Supplier coding rule', supplierId);
    await deleteRule(companyId, supplierId);
    log.info('Supplier rule deleted via API', { companyId, supplierId }, 'supplier-rules-api');
    return apiResponse.noContent(res);
  }

  return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET', 'PATCH', 'DELETE']);
}

async function routedHandler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method === 'GET') return handler(req, res);
  return withWriteAccess(handler as Parameters<typeof withWriteAccess>[0])(req, res);
}

export default withAuth(withErrorHandler(withCsrf(routedHandler as Parameters<typeof withErrorHandler>[0])));
