/**
 * Portal Invoice — Generate Token (internal, auth required)
 * POST /api/portal/invoice/generate
 * Body: { invoiceId: string }
 * Returns: { token, portalUrl }
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import crypto from 'crypto';

type Row = Record<string, unknown>;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method!, ['POST']);
  }

  const authReq = req as AuthenticatedNextApiRequest;
  const { invoiceId } = req.body as { invoiceId?: string };

  if (!invoiceId) {
    return apiResponse.badRequest(res, 'invoiceId is required');
  }

  const userId = authReq.user.id;

  const companyRows = (await sql`
    SELECT company_id FROM company_users
    WHERE user_id = ${userId}
    ORDER BY is_default DESC, created_at ASC
    LIMIT 1
  `) as Row[];

  if (!companyRows[0]) {
    return apiResponse.badRequest(res, 'No company assigned to user');
  }
  const companyId = String(companyRows[0].company_id);

  const existing = (await sql`
    SELECT id, portal_token FROM customer_invoices
    WHERE id = ${invoiceId}::UUID
      AND company_id = ${companyId}::UUID
      AND status != 'cancelled'
    LIMIT 1
  `) as Row[];

  if (!existing[0]) {
    return apiResponse.notFound(res, 'Invoice');
  }

  let token = existing[0].portal_token != null ? String(existing[0].portal_token) : null;

  if (!token) {
    token = crypto.randomBytes(32).toString('hex');
    await sql`
      UPDATE customer_invoices
      SET portal_token = ${token}
      WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID
    `;
    log.info('Portal token generated', { invoiceId }, 'Portal');
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3101';
  const portalUrl = `${appUrl}/portal/invoice/${token}`;

  return apiResponse.success(res, { token, portalUrl });
}

export default withAuth(withErrorHandler(handler));
