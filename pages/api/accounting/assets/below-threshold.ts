/**
 * GET  /api/accounting/assets/below-threshold — list assets flagged below cap threshold
 * POST /api/accounting/assets/below-threshold — expense an asset below threshold to GL
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { sql } from '@/lib/neon';
import { checkCapitalizationThreshold } from '@/modules/accounting/services/items/farDepreciationService';
import { postCapitalizationExpenseToGL } from '@/modules/accounting/services/gl/glCrossModuleHooks';

type Row = Record<string, unknown>;

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const companyId = (req as unknown as CompanyAuthedRequest).companyId;
  const userId = String(req.user.id);

  if (req.method === 'GET') {
    // Return all assets flagged as below threshold (or auto-detect from category threshold)
    const rows = (await sql`
      SELECT
        a.id, a.asset_number, a.name, a.purchase_price AS cost,
        a.below_threshold, a.status, a.created_at,
        c.name AS category_name,
        COALESCE(c.capitalization_threshold, 5000) AS threshold
      FROM assets a
      LEFT JOIN asset_categories c ON c.id = a.category_id
      WHERE a.company_id = ${companyId}::UUID
        AND a.purchase_price < COALESCE(c.capitalization_threshold, 5000)
        AND a.status NOT IN ('disposed', 'written_off')
      ORDER BY a.created_at DESC
    `) as Row[];

    return apiResponse.success(res, rows.map(r => ({
      ...r,
      belowThreshold: true,
      suggestedTreatment: 'expense',
    })));
  }

  if (req.method === 'POST') {
    // Expense a specific below-threshold asset to GL
    const { assetId } = req.body as { assetId?: string };
    if (!assetId) return apiResponse.badRequest(res, 'assetId is required');

    const assetRows = (await sql`
      SELECT a.id, a.purchase_price AS cost, a.status,
             COALESCE(c.capitalization_threshold, 5000) AS threshold
      FROM assets a
      LEFT JOIN asset_categories c ON c.id = a.category_id
      WHERE a.id = ${assetId}::UUID AND a.company_id = ${companyId}::UUID
    `) as Row[];

    if (!assetRows[0]) return apiResponse.notFound(res, 'Asset not found');

    const asset = assetRows[0];
    const cost = Number(asset.cost);
    const threshold = Number(asset.threshold);

    const check = checkCapitalizationThreshold({ cost, threshold });
    if (!check.belowThreshold) {
      return apiResponse.badRequest(res, `Asset cost ${cost} is at or above threshold ${threshold}`);
    }

    const entryId = await postCapitalizationExpenseToGL(companyId, assetId, cost, userId);
    return apiResponse.success(res, { assetId, cost, threshold, journalEntryId: entryId });
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}

export default withAuth(withCsrf(withErrorHandler(handler)));
