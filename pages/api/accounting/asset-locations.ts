/**
 * Asset Locations API — managed dropdown values for asset location field
 * GET    /api/accounting/asset-locations         — list active locations
 * POST   /api/accounting/asset-locations         — create location { name }
 * PATCH  /api/accounting/asset-locations?id=     — rename location { name }
 * DELETE /api/accounting/asset-locations?id=     — soft-delete (is_active=false)
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = Record<string, unknown>;

async function handler(req: CompanyApiRequest, res: NextApiResponse) {
  const companyId = req.companyId;

  // ── GET ────────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const rows = await sql`
      SELECT id, name
      FROM asset_locations
      WHERE company_id = ${companyId}
        AND is_active = true
      ORDER BY name
    ` as Row[];

    return apiResponse.success(res, rows);
  }

  // ── POST ───────────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const { name } = req.body as { name?: string };

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return apiResponse.badRequest(res, 'name is required');
    }
    const trimmed = name.trim().slice(0, 100);

    const rows = await sql`
      INSERT INTO asset_locations (company_id, name)
      VALUES (${companyId}, ${trimmed})
      ON CONFLICT (company_id, name)
        DO UPDATE SET is_active = true
      RETURNING id, name
    ` as Row[];

    log.info('asset_location.created', { companyId, name: trimmed });
    return apiResponse.created(res, rows[0]);
  }

  // ── PATCH ──────────────────────────────────────────────────────────────────
  if (req.method === 'PATCH') {
    const id = req.query.id as string | undefined;
    if (!id) return apiResponse.badRequest(res, 'id query param required');

    const { name } = req.body as { name?: string };
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return apiResponse.badRequest(res, 'name is required');
    }
    const trimmed = name.trim().slice(0, 100);

    const rows = await sql`
      UPDATE asset_locations
      SET name = ${trimmed}
      WHERE id = ${id}
        AND company_id = ${companyId}
      RETURNING id, name
    ` as Row[];

    if (rows.length === 0) return apiResponse.notFound(res, 'Location not found');

    log.info('asset_location.renamed', { companyId, id, name: trimmed });
    return apiResponse.success(res, rows[0]);
  }

  // ── DELETE ─────────────────────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    const id = req.query.id as string | undefined;
    if (!id) return apiResponse.badRequest(res, 'id query param required');

    const rows = await sql`
      UPDATE asset_locations
      SET is_active = false
      WHERE id = ${id}
        AND company_id = ${companyId}
      RETURNING id
    ` as Row[];

    if (rows.length === 0) return apiResponse.notFound(res, 'Location not found');

    log.info('asset_location.deleted', { companyId, id });
    return apiResponse.success(res, { id });
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST', 'PATCH', 'DELETE']);
}

export default withCompany(withErrorHandler(withCsrf(handler)));
