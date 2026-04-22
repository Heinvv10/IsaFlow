/**
 * GET  /api/accounting/capture/whatsapp-inbox → { data: { id, address, isActive } | null }
 * POST /api/accounting/capture/whatsapp-inbox body: { address: string }
 *      → { data: { id, address, isActive } }
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
  const userId = req.user?.id;

  if (req.method === 'GET') {
    const rows = (await sql`
      SELECT id, address, is_active
      FROM capture_inboxes
      WHERE company_id = ${companyId} AND channel = 'whatsapp' AND is_active = true
      LIMIT 1
    `) as Row[];

    const row = rows[0] ?? null;
    return apiResponse.success(res, row
      ? { id: row.id as string, address: row.address as string, isActive: row.is_active as boolean }
      : null,
    );
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

    // Deactivate any existing whatsapp inbox first
    await sql`
      UPDATE capture_inboxes
      SET is_active = false, updated_at = NOW()
      WHERE company_id = ${companyId} AND channel = 'whatsapp' AND is_active = true
    `;

    const inserted = (await sql`
      INSERT INTO capture_inboxes (company_id, channel, address, is_active, created_by)
      VALUES (${companyId}, 'whatsapp', ${address}, true, ${userId ?? null})
      RETURNING id, address, is_active
    `) as Row[];

    const row = inserted[0]!;
    log.info('Upserted WhatsApp capture inbox', { companyId, address }, 'whatsapp-inbox');

    return apiResponse.success(res, {
      id: row.id as string,
      address: row.address as string,
      isActive: row.is_active as boolean,
    });
  }

  return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0])));
