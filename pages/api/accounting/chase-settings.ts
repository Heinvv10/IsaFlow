/**
 * GET /api/accounting/chase-settings → current company's chase-auto-send flags.
 * PATCH body { chaseAutoSendEnabled?: boolean; chaseGraceDays?: number; whatsappChaseEnabled?: boolean }
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';

type Row = Record<string, unknown>;
interface PatchBody {
  chaseAutoSendEnabled?: boolean;
  chaseGraceDays?: number;
  whatsappChaseEnabled?: boolean;
}

function mapRow(row: Row) {
  return {
    chaseAutoSendEnabled: Boolean(row.chase_auto_send_enabled),
    chaseGraceDays: Number(row.chase_grace_days ?? 3),
    whatsappChaseEnabled: Boolean(row.whatsapp_chase_enabled),
  };
}

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  const { companyId } = req;

  if (req.method === 'GET') {
    const rows = (await sql`
      SELECT chase_auto_send_enabled, chase_grace_days, whatsapp_chase_enabled
      FROM companies
      WHERE id = ${companyId}::uuid
      LIMIT 1
    `) as Row[];
    const row = rows[0];
    if (!row) return apiResponse.notFound(res, 'Company', companyId);
    return apiResponse.success(res, mapRow(row));
  }

  if (req.method === 'PATCH') {
    const body = (req.body ?? {}) as PatchBody;
    const enabledProvided = typeof body.chaseAutoSendEnabled === 'boolean';
    const graceProvided = typeof body.chaseGraceDays === 'number';
    const waProvided = typeof body.whatsappChaseEnabled === 'boolean';

    if (!enabledProvided && !graceProvided && !waProvided) {
      return apiResponse.badRequest(res, 'At least one of chaseAutoSendEnabled | chaseGraceDays | whatsappChaseEnabled is required');
    }
    if (graceProvided && (body.chaseGraceDays! < 0 || body.chaseGraceDays! > 30)) {
      return apiResponse.badRequest(res, 'chaseGraceDays must be between 0 and 30');
    }

    const rows = (await sql`
      UPDATE companies SET
        chase_auto_send_enabled = COALESCE(${enabledProvided ? body.chaseAutoSendEnabled : null}, chase_auto_send_enabled),
        chase_grace_days        = COALESCE(${graceProvided ? body.chaseGraceDays : null}::int, chase_grace_days),
        whatsapp_chase_enabled  = COALESCE(${waProvided ? body.whatsappChaseEnabled : null}, whatsapp_chase_enabled),
        updated_at              = NOW()
      WHERE id = ${companyId}::uuid
      RETURNING chase_auto_send_enabled, chase_grace_days, whatsapp_chase_enabled
    `) as Row[];

    const row = rows[0];
    if (!row) return apiResponse.notFound(res, 'Company', companyId);

    log.info('Updated chase settings', {
      companyId,
      chaseAutoSendEnabled: row.chase_auto_send_enabled,
      chaseGraceDays: row.chase_grace_days,
      whatsappChaseEnabled: row.whatsapp_chase_enabled,
    }, 'chase-settings');

    return apiResponse.success(res, mapRow(row));
  }

  return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET', 'PATCH']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0]))));
