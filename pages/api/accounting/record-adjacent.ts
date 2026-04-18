/**
 * Record Adjacent API
 * GET /api/accounting/record-adjacent?entity=customers&id=UUID
 * Returns { prevId, nextId } using a window query for Sage-style record navigation.
 *
 * Supported entities: customers | suppliers | items
 * Order: customers/suppliers sort by name; items sort by description.
 */

import type { NextApiResponse } from 'next';
import { sql } from '@/lib/neon';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { log } from '@/lib/logger';

type SupportedEntity = 'customers' | 'suppliers' | 'items';

const SUPPORTED_ENTITIES: readonly SupportedEntity[] = ['customers', 'suppliers', 'items'];

function isValidEntity(v: string): v is SupportedEntity {
  return (SUPPORTED_ENTITIES as readonly string[]).includes(v);
}

interface AdjacentRow {
  prev_id: string | null;
  next_id: string | null;
}

interface AdjacentResult {
  prevId: string | null;
  nextId: string | null;
}

async function queryAdjacent(
  entity: SupportedEntity,
  companyId: string,
  id: string
): Promise<AdjacentRow[]> {
  if (entity === 'customers') {
    return (await sql`
      WITH ordered AS (
        SELECT
          id,
          LAG(id)  OVER (ORDER BY name) AS prev_id,
          LEAD(id) OVER (ORDER BY name) AS next_id
        FROM customers
        WHERE company_id = ${companyId}
      )
      SELECT prev_id, next_id FROM ordered WHERE id = ${id}::uuid
    `) as AdjacentRow[];
  }

  if (entity === 'suppliers') {
    return (await sql`
      WITH ordered AS (
        SELECT
          id,
          LAG(id)  OVER (ORDER BY name) AS prev_id,
          LEAD(id) OVER (ORDER BY name) AS next_id
        FROM suppliers
        WHERE company_id = ${companyId}
      )
      SELECT prev_id, next_id FROM ordered WHERE id = ${id}::uuid
    `) as AdjacentRow[];
  }

  // entity === 'items'
  return (await sql`
    WITH ordered AS (
      SELECT
        id,
        LAG(id)  OVER (ORDER BY description) AS prev_id,
        LEAD(id) OVER (ORDER BY description) AS next_id
      FROM items
      WHERE company_id = ${companyId}
    )
    SELECT prev_id, next_id FROM ordered WHERE id = ${id}::uuid
  `) as AdjacentRow[];
}

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.badRequest(res, 'Method not allowed');
  }

  const { entity, id } = req.query;
  const companyId = req.companyId;

  if (!entity || typeof entity !== 'string' || !isValidEntity(entity)) {
    return apiResponse.badRequest(
      res,
      'Invalid or missing entity. Must be one of: customers, suppliers, items'
    );
  }

  if (!id || typeof id !== 'string') {
    return apiResponse.badRequest(res, 'Missing required parameter: id');
  }

  log.info('record-adjacent lookup', { entity, id }, 'record-adjacent');

  const rows = await queryAdjacent(entity, companyId, id);
  const row = rows[0];

  if (!row) {
    return apiResponse.notFound(res, entity.slice(0, -1), id);
  }

  const result: AdjacentResult = {
    prevId: row.prev_id ?? null,
    nextId: row.next_id ?? null,
  };

  return apiResponse.success(res, result);
}

export default withAuth(withErrorHandler(handler as never));
