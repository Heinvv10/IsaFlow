/**
 * Duplicate Merge API
 * POST /api/accounting/duplicates-merge
 *
 * Merges a duplicate entity into a primary entity, reassigning all
 * related transactions, then soft-deletes the duplicate.
 * PRD: WS-6.6 — Duplicate Detection and Merge Wizard
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import type { AuthenticatedNextApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { mergeEntities } from '@/modules/accounting/services/duplicateDetectionService';

const VALID_ENTITY_TYPES = ['customer', 'supplier', 'item'] as const;
type EntityType = typeof VALID_ENTITY_TYPES[number];

const MERGE_ALLOWED_ROLES = ['owner', 'admin', 'manager'];

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const companyReq = req as CompanyApiRequest;
  const { companyId, companyRole } = companyReq;
  const userId = (req as AuthenticatedNextApiRequest).user.id;

  // Only privileged roles can merge entities
  if (!MERGE_ALLOWED_ROLES.includes(companyRole)) {
    return apiResponse.forbidden(res, 'Only owners, admins, and managers can merge duplicate entities');
  }

  const { entityType, primaryId, duplicateId } = req.body as {
    entityType?: string;
    primaryId?: string;
    duplicateId?: string;
  };

  if (!entityType || !primaryId || !duplicateId) {
    return apiResponse.badRequest(res, 'entityType, primaryId, and duplicateId are required');
  }

  if (!VALID_ENTITY_TYPES.includes(entityType as EntityType)) {
    return apiResponse.badRequest(res, `entityType must be one of: ${VALID_ENTITY_TYPES.join(', ')}`);
  }

  if (primaryId === duplicateId) {
    return apiResponse.badRequest(res, 'primaryId and duplicateId must be different');
  }

  try {
    const result = await mergeEntities(
      companyId,
      entityType as EntityType,
      primaryId,
      duplicateId,
      userId,
    );

    log.info('Entity merge complete', {
      companyId, entityType, primaryId, duplicateId, userId,
      reassigned: result.reassignedTransactions,
    }, 'duplicates-api');

    return apiResponse.success(res, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to merge entities';
    log.error('Entity merge failed', { error: err, companyId, entityType, primaryId, duplicateId }, 'duplicates-api');
    return apiResponse.badRequest(res, message);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
