/**
 * UDF Definitions API
 * GET  ?entityType=customer  — list definitions for an entity type
 * POST                       — upsert a single UDF definition
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import {
  getUdfDefinitions,
  upsertUdfDefinition,
  type UdfEntityType,
  type UdfDefinitionInput,
} from '@/modules/accounting/services/core/udfService';

const VALID_ENTITY_TYPES: UdfEntityType[] = ['customer', 'supplier', 'invoice', 'item'];
const VALID_FIELD_TYPES = ['text', 'number', 'date', 'boolean', 'select'];

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method === 'GET') {
    const entityType = req.query.entityType as string;
    if (!entityType || !VALID_ENTITY_TYPES.includes(entityType as UdfEntityType)) {
      return apiResponse.badRequest(
        res,
        `entityType query param required: ${VALID_ENTITY_TYPES.join(', ')}`,
      );
    }

    const defs = await getUdfDefinitions(companyId, entityType as UdfEntityType);
    return apiResponse.success(res, defs);
  }

  if (req.method === 'POST') {
    const body = req.body as Partial<UdfDefinitionInput>;
    const { entityType, fieldNumber, fieldLabel, fieldType } = body;

    if (!entityType || !VALID_ENTITY_TYPES.includes(entityType)) {
      return apiResponse.badRequest(
        res,
        `entityType required: ${VALID_ENTITY_TYPES.join(', ')}`,
      );
    }
    if (!fieldNumber || fieldNumber < 1 || fieldNumber > 12) {
      return apiResponse.badRequest(res, 'fieldNumber required (1–12)');
    }
    if (!fieldLabel || fieldLabel.trim().length === 0) {
      return apiResponse.badRequest(res, 'fieldLabel required');
    }
    if (!fieldType || !VALID_FIELD_TYPES.includes(fieldType)) {
      return apiResponse.badRequest(
        res,
        `fieldType required: ${VALID_FIELD_TYPES.join(', ')}`,
      );
    }

    const def = await upsertUdfDefinition(companyId, body as UdfDefinitionInput);
    return apiResponse.success(res, def);
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}

export default withCompany(withErrorHandler(withCsrf(withWriteAccess(handler))));
