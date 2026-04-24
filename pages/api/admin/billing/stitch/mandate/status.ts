/**
 * GET /api/admin/billing/stitch/mandate/status
 * Returns the current active/pending mandate for the tenant + last 5 charges.
 * Used by the billing page's "Recurring debit" card.
 */

import type { NextApiResponse } from 'next';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { sql } from '@/lib/neon';

interface MandateRow {
  id: string;
  status: string;
  bank_name: string | null;
  masked_account_number: string | null;
  max_amount_cents: string;
  authorised_at: Date | string | null;
}

interface ChargeRow {
  id: string;
  period_start: Date | string;
  period_end: Date | string;
  amount_cents: string;
  status: string;
  attempt_count: number;
  last_attempt_at: Date | string | null;
  settled_at: Date | string | null;
  failure_reason: string | null;
}

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method!, ['GET']);
  }

  const mandates = await sql<MandateRow>`
    SELECT id, status, bank_name, masked_account_number, max_amount_cents, authorised_at
    FROM subscription_mandates
    WHERE company_id = ${req.companyId}
      AND status IN ('active','pending')
    ORDER BY (status = 'active') DESC, created_at DESC
    LIMIT 1
  `;

  const charges = await sql<ChargeRow>`
    SELECT id, period_start, period_end, amount_cents, status,
           attempt_count, last_attempt_at, settled_at, failure_reason
    FROM subscription_charges
    WHERE company_id = ${req.companyId}
    ORDER BY period_start DESC
    LIMIT 5
  `;

  return apiResponse.success(res, {
    mandate: mandates[0] ?? null,
    charges,
  });
}

export default withAuth(withErrorHandler(handler));
