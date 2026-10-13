/**
 * GET  /api/accounting/supplier-rules         — list all rules for company
 * POST /api/accounting/supplier-rules         — upsert a rule
 *   body: { supplierId: string, ...SupplierRule patch }
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import { log } from '@/lib/logger';
import { getRule, listRules, upsertRule } from '@/modules/accounting/services/capture/supplierRulesService';
import { AutoPublishNeedsAccountError } from '@/modules/accounting/services/capture/supplierRuleErrors';
import {
  applySupplierDefaultsPlan, planSupplierDefaults, supplierDefaultRefsFromBody,
} from '@/modules/accounting/services/gl/dimensions/supplierDimensionDefaults';
import { isDimensionRefusal } from '@/modules/accounting/services/gl/dimensions/dimensionTypes';
import { SupplierNotInCompanyError } from '@/modules/accounting/services/core/contactDirectoryService';

// `strict()` — every field the UI in
// pages/accounting/suppliers/[supplierId]/rules.tsx sends is now declared
// explicitly below (including the two tolerance fields). passthrough() would
// be needlessly permissive — `__proto__`, future typos, anything would flow
// through to the service. The service has its own column allowlist as a
// second line of defence, but the API contract should be tight.
const UpsertSupplierRuleSchema = z.object({
  supplierId: UUID,
  defaultGlAccountId: UUID.nullable().optional(),
  defaultVatCode: z.string().max(20).nullable().optional(),
  defaultCostCentreId: UUID.nullable().optional(),
  defaultProjectId: UUID.nullable().optional(),
  defaultCc1Id: UUID.nullable().optional(),
  defaultCc2Id: UUID.nullable().optional(),
  defaultBuId: UUID.nullable().optional(),
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

  if (req.method === 'GET') {
    const rules = await listRules(companyId);
    return apiResponse.success(res, rules);
  }

  if (req.method === 'POST') {
    const parsed = UpsertSupplierRuleSchema.safeParse(req.body);
    if (!parsed.success) {
      // Cast: Zod's flatten()() declares values as string[] | undefined while
      // apiResponse.validationError signature is Record<string, string | string[]>.
      return apiResponse.validationError(
        res,
        parsed.error.flatten().fieldErrors as Record<string, string | string[]>,
      );
    }
    const { supplierId, defaultCc1Id, defaultCc2Id, defaultBuId, ...patch } = parsed.data;
    const dimRefs = supplierDefaultRefsFromBody({ defaultCc1Id, defaultCc2Id, defaultBuId });

    let rule;
    try {
      // Every dimension refusal comes from reads, before the upsert writes anything.
      const dimPlan = dimRefs ? await planSupplierDefaults(companyId, supplierId, dimRefs) : null;
      rule = await upsertRule(companyId, supplierId, patch, userId);
      if (dimPlan) {
        await applySupplierDefaultsPlan(companyId, dimPlan, userId || null);
        rule = await getRule(companyId, supplierId);
      }
    } catch (err) {
      // R-068: refused before the upsert, so nothing has been written.
      if (err instanceof SupplierNotInCompanyError) return apiResponse.badRequest(res, err.message);
      if (isDimensionRefusal(err)) return apiResponse.badRequest(res, err.message);
      if (err instanceof AutoPublishNeedsAccountError) return apiResponse.badRequest(res, err.message);
      throw err;
    }
    log.info('Supplier rule upserted via API', { companyId, supplierId }, 'supplier-rules-api');
    return apiResponse.created(res, rule, 'Supplier rule saved');
  }

  return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET', 'POST']);
}

// GET: read-only — withAuth only; POST: mutating — withWriteAccess added
async function routedHandler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method === 'GET') return handler(req, res);
  return withWriteAccess(handler as Parameters<typeof withWriteAccess>[0])(req, res);
}

export default withAuth(withErrorHandler(withCsrf(routedHandler as Parameters<typeof withErrorHandler>[0])));
