/**
 * POST /api/accounting/capture/api-keys/[id]/revoke
 * Revoke a capture API key.
 *
 * The WHERE clause includes company_id so an attacker cannot revoke a key
 * belonging to a different tenant (IDOR protection).
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';

type Row = Record<string, unknown>;

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? '', ['POST']);
  }

  const { companyId } = req;
  const { id } = req.query as { id: string };

  if (!id || typeof id !== 'string') {
    return apiResponse.badRequest(res, 'Missing key id');
  }

  const rows = await sql`
    UPDATE capture_api_keys
    SET is_active = false,
        revoked_at = NOW()
    WHERE id = ${id}::uuid
      AND company_id = ${companyId}
      AND is_active = true
    RETURNING id
  ` as Row[];

  if (rows.length === 0) {
    return apiResponse.notFound(res, 'API key', id);
  }

  log.info(
    'capture api key revoked',
    { companyId, keyId: id },
    'capture-api-key',
  );

  return apiResponse.success(res, { id, revoked: true });
}

export default withAuth(withErrorHandler(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0])));
