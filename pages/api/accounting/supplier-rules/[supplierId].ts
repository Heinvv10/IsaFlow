/**
 * GET    /api/accounting/supplier-rules/[supplierId] — get rule for supplier
 * PATCH  /api/accounting/supplier-rules/[supplierId] — update rule
 * DELETE /api/accounting/supplier-rules/[supplierId] — remove rule
 *
 * supplierId is the supplier FK (matches UNIQUE constraint on supplier_coding_rules).
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import { log } from '@/lib/logger';
import {
  getRule,
  upsertRule,
  deleteRule,
} from '@/modules/accounting/services/capture/supplierRulesService';

// `strict()` — the UI sends `qtyTolerancePct`, `priceTolerancePct`, and
// `supplierId` (redundantly, because the URL already carries it). All three
// are now declared explicitly below; the body `supplierId` is dropped before
// reaching the service so the URL stays the source of truth. passthrough()
// would let unknown keys flow into the service patch object.
const PatchSchema = z.object({
  supplierId: UUID.optional(),
  defaultGlAccountId: UUID.nullable().optional(),
  defaultVatCode: z.string().max(20).nullable().optional(),
  defaultCostCentreId: UUID.nullable().optional(),
  defaultProjectId: UUID.nullable().optional(),
  autoPublish: z.boolean().optional(),
  autoPublishMaxAmount: z.number().nullable().optional(),
  autoPublishMinConfidence: z.number().min(0).max(1).optional(),
  requirePoMatch: z.boolean().optional(),
  qtyTolerancePct: z.number().min(0).max(100).optional(),
  priceTolerancePct: z.number().min(0).max(100).optional(),
}).strict();

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  const { companyId } = req;
  const userId = req.user?.id ?? '';
  const idParse = UUID.safeParse(req.query.supplierId);
  if (!idParse.success) return apiResponse.badRequest(res, 'supplierId must be a valid UUID');
  const supplierId = idParse.data;

  if (req.method === 'GET') {
    const rule = await getRule(companyId, supplierId);
    if (!rule) return apiResponse.notFound(res, 'Supplier coding rule', supplierId);
    return apiResponse.success(res, rule);
  }

  if (req.method === 'PATCH') {
    const parsed = PatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return apiResponse.validationError(
        res,
        parsed.error.flatten().fieldErrors as Record<string, string | string[]>,
      );
    }
    // Drop the redundant `supplierId` the UI sends in the body — the URL is
    // the source of truth for which rule we're editing.
    const { supplierId: _ignored, ...patch } = parsed.data;
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
