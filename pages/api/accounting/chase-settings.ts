/**
 * GET /api/accounting/chase-settings → current company's auto-chase flags.
 * PATCH same path body { chaseAutoSendEnabled?: boolean; chaseGraceDays?: number }
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';

type Row = Record<string, unknown>;

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  const { companyId } = req;

  if (req.method === 'GET') {
    const rows = (await sql`
      SELECT chase_auto_send_enabled, chase_grace_days
      FROM companies
      WHERE id = ${companyId}::uuid
      LIMIT 1
    `) as Row[];
    const row = rows[0];
    if (!row) return apiResponse.notFound(res, 'Company', companyId);
    return apiResponse.success(res, {
      chaseAutoSendEnabled: Boolean(row.chase_auto_send_enabled),
      chaseGraceDays: Number(row.chase_grace_days ?? 3),
    });
  }

  if (req.method === 'PATCH') {
    const body = (req.body ?? {}) as { chaseAutoSendEnabled?: boolean; chaseGraceDays?: number };
    const enabledProvided = typeof body.chaseAutoSendEnabled === 'boolean';
    const graceProvided = typeof body.chaseGraceDays === 'number';

    if (!enabledProvided && !graceProvided) {
      return apiResponse.badRequest(res, 'At least one of chaseAutoSendEnabled | chaseGraceDays is required');
    }
    if (graceProvided && (body.chaseGraceDays! < 0 || body.chaseGraceDays! > 30)) {
      return apiResponse.badRequest(res, 'chaseGraceDays must be between 0 and 30');
    }

    const rows = (await sql`
      UPDATE companies SET
        chase_auto_send_enabled = COALESCE(${enabledProvided ? body.chaseAutoSendEnabled : null}, chase_auto_send_enabled),
        chase_grace_days        = COALESCE(${graceProvided ? body.chaseGraceDays : null}::int, chase_grace_days),
        updated_at              = NOW()
      WHERE id = ${companyId}::uuid
      RETURNING chase_auto_send_enabled, chase_grace_days
    `) as Row[];

    const row = rows[0];
    if (!row) return apiResponse.notFound(res, 'Company', companyId);

    log.info('Updated chase settings', {
      companyId,
      chaseAutoSendEnabled: row.chase_auto_send_enabled,
      chaseGraceDays: row.chase_grace_days,
    }, 'chase-settings');

    return apiResponse.success(res, {
      chaseAutoSendEnabled: Boolean(row.chase_auto_send_enabled),
      chaseGraceDays: Number(row.chase_grace_days),
    });
  }

  return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET', 'PATCH']);
}

export default withAuth(withErrorHandler(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0])));
