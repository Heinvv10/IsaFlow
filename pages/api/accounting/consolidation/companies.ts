/**
 * Consolidation: Group Companies API
 * GET  — list parent + direct subsidiaries for the current company
 * POST — add a subsidiary relationship (child must be accessible to current user)
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  getGroupCompanies,
  createCompanyRelationship,
} from '@/modules/accounting/services/consolidationService';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

type Row = DbRow;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;

  if (req.method === 'GET') {
    const items = await getGroupCompanies(companyId);
    return apiResponse.success(res, { items });
  }

  if (req.method === 'POST') {
    const {
      childCompanyId,
      ownershipPercent = 100,
      relationshipType = 'subsidiary',
    } = req.body as {
      childCompanyId?: string;
      ownershipPercent?: number;
      relationshipType?: string;
    };

    if (!childCompanyId) {
      return apiResponse.badRequest(res, 'childCompanyId is required');
    }

    // Verify the child company exists
    const exists = (await sql`
      SELECT id FROM companies WHERE id = ${childCompanyId}::UUID LIMIT 1
    `) as Row[];

    if (exists.length === 0) {
      return apiResponse.notFound(res, 'Child company not found');
    }

    try {
      await createCompanyRelationship(
        companyId,
        childCompanyId,
        Number(ownershipPercent),
        userId,
        relationshipType,
      );
      const items = await getGroupCompanies(companyId);
      return apiResponse.success(res, { items });
    } catch (err) {
      log.error('Failed to create company relationship', { companyId, childCompanyId, error: err }, 'consolidation-api');
      return apiResponse.badRequest(res, err instanceof Error ? err.message : 'Failed to create relationship');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}

export default withCompany(withErrorHandler(handler as Parameters<typeof withCompany>[0]));
