/**
 * Merchant category mappings (shared merchant-pattern pool, learning loop PR 2).
 * GET  /api/accounting/category-mappings  — the ISAFlow category list with this company's account for each,
 *      plus `sharingAvailable` (the MERCHANT_SHARING_ENABLED legal-review gate, merchantSharingGate.ts), so the
 *      page can say pooling is pending legal review without a NEXT_PUBLIC variable
 * POST /api/accounting/category-mappings
 *   { action: 'save', categoryCode, glAccountId | null }  — map (or clear) one category
 *   { action: 'auto_map' }                                — fill unmapped categories by account name
 *
 * A mapping names the company's OWN account (composite FK, and the service checks it); the pool itself
 * stores categories only. Rules: src/modules/accounting/services/sharedPool/categoryMappingService.ts.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import {
  autoMapCategories, CategoryMappingRefusal, listCategoryMappings, saveCategoryMapping,
} from '@/modules/accounting/services/sharedPool/categoryMappingService';
import { isMerchantSharingEnabled } from '@/modules/bureau/services/merchantSharingGate';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId, user } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    return apiResponse.success(res, { ...(await listCategoryMappings(companyId)), sharingAvailable: isMerchantSharingEnabled() });
  }

  if (req.method === 'POST') {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.action === 'auto_map') {
      return apiResponse.success(res, await autoMapCategories(companyId, user.id));
    }
    if (body.action === 'save') {
      const { categoryCode, glAccountId } = body;
      if (typeof categoryCode !== 'string' || categoryCode.length === 0) {
        return apiResponse.validationError(res, { categoryCode: 'Category code required' });
      }
      if (glAccountId !== null && (typeof glAccountId !== 'string' || !UUID_RE.test(glAccountId))) {
        return apiResponse.validationError(res, { glAccountId: 'An account id, or null to clear the mapping' });
      }
      try {
        await saveCategoryMapping(companyId, user.id, categoryCode, glAccountId);
      } catch (err) {
        if (err instanceof CategoryMappingRefusal) return apiResponse.badRequest(res, err.message);
        throw err;
      }
      return apiResponse.success(res, { saved: true });
    }
    return apiResponse.badRequest(res, "action must be 'save' or 'auto_map'");
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
