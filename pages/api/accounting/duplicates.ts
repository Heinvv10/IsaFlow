/**
 * Duplicate Detection API
 * GET /api/accounting/duplicates?entity_type=customer|supplier|item
 *
 * Scans for potential duplicate entities within the active company.
 * PRD: WS-6.6 — Duplicate Detection and Merge Wizard
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { detectDuplicates } from '@/modules/accounting/services/duplicateDetectionService';

const VALID_ENTITY_TYPES = ['customer', 'supplier', 'item'] as const;
type EntityType = typeof VALID_ENTITY_TYPES[number];

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyApiRequest;
  const { entity_type } = req.query;

  if (!entity_type || typeof entity_type !== 'string') {
    return apiResponse.badRequest(res, 'entity_type query parameter is required');
  }

  if (!VALID_ENTITY_TYPES.includes(entity_type as EntityType)) {
    return apiResponse.badRequest(res, `entity_type must be one of: ${VALID_ENTITY_TYPES.join(', ')}`);
  }

  try {
    const duplicates = await detectDuplicates(companyId, entity_type as EntityType);
    log.info('Duplicate detection complete', { companyId, entityType: entity_type, found: duplicates.length }, 'duplicates-api');
    return apiResponse.success(res, { duplicates });
  } catch (err) {
    log.error('Duplicate detection failed', { error: err, companyId, entityType: entity_type }, 'duplicates-api');
    return apiResponse.badRequest(res, 'Failed to detect duplicates');
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
