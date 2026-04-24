/**
 * GET /api/admin/billing/stitch/mandate/verify?ref=<externalReference>
 * Called by the admin mandate-return landing page to resolve the final
 * authorisation status. Always scoped by company_id from the auth session.
 */

import type { NextApiResponse } from 'next';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { sql } from '@/lib/neon';

interface Row {
  mandate_id: string;
  mandate_status: string;
  max_amount_cents: string | null;
  bank_name: string | null;
  masked_account_number: string | null;
  authorised_at: Date | string | null;
}

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method!, ['GET']);
  }
  const ref = typeof req.query.ref === 'string' ? req.query.ref : '';
  if (!ref) return apiResponse.badRequest(res, 'Missing ref');

  const rows = await sql<Row>`
    SELECT m.id AS mandate_id, m.status AS mandate_status,
           m.max_amount_cents, m.bank_name, m.masked_account_number, m.authorised_at
    FROM stitch_payment_requests pr
    JOIN subscription_mandates m ON m.id = pr.mandate_id
    WHERE pr.external_reference = ${ref}
      AND pr.company_id = ${req.companyId}
      AND pr.purpose = 'mandate_authorisation'
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return apiResponse.notFound(res, 'Mandate');

  const publicStatus =
    row.mandate_status === 'active' ? 'active'
    : row.mandate_status === 'failed' ? 'failed'
    : row.mandate_status === 'revoked' || row.mandate_status === 'expired' ? 'cancelled'
    : 'pending';

  const nextChargeDate = row.authorised_at
    ? new Date(new Date(row.authorised_at).getFullYear(), new Date(row.authorised_at).getMonth() + 1, 1).toISOString()
    : undefined;

  return apiResponse.success(res, {
    status: publicStatus,
    mandateId: row.mandate_id,
    bankName: row.bank_name ?? undefined,
    maskedAccountNumber: row.masked_account_number ?? undefined,
    maxAmountCents: row.max_amount_cents ? Number(row.max_amount_cents) : undefined,
    nextChargeDate,
  });
}

export default withAuth(withErrorHandler(handler));
