import { configureWhatsAppInbox } from '@/modules/accounting/services/capture/whatsAppInboxService';
/** GET returns active/pending status. POST starts provider verification; it does not activate routing. */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';

type Row = Record<string, unknown>;

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  const { companyId } = req;
  const userId = req.user?.id;

  if (req.method === 'GET') {
    const active = (await sql`
      SELECT id, address, (is_active AND provider_verified_at IS NOT NULL) AS is_active
      FROM capture_inboxes WHERE company_id = ${companyId} AND channel = 'whatsapp' AND is_active
      LIMIT 1
    `) as Row[];
    const pending = (await sql`
      SELECT address, expires_at FROM capture_whatsapp_claims WHERE company_id = ${companyId}
    `) as Row[];
    res.setHeader('Cache-Control', 'no-store');
    return apiResponse.success(res, { active: active[0] ? {
      id: active[0].id, address: active[0].address, isActive: active[0].is_active,
    } : null, pending: pending[0] ? {
      address: pending[0].address, expiresAt: pending[0].expires_at,
    } : null });
  }

  if (req.method === 'POST') {
    const body = (req.body ?? {}) as { address?: string };
    const address = (body.address ?? '').trim();

    if (!address) {
      return apiResponse.badRequest(res, 'address is required');
    }
    if (!/^\+\d{7,15}$/.test(address)) {
      return apiResponse.badRequest(res, 'address must be E.164 format e.g. +27821234567');
    }

    const row = await configureWhatsAppInbox(companyId, address, userId);
    log.info('Started WhatsApp provider verification', { companyId, address }, 'whatsapp-inbox');

    res.setHeader('Cache-Control', 'no-store');
    return apiResponse.success(res, row);
  }

  return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0]))));
