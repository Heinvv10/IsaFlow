/**
 * POST /api/accounting/expense-claims/mileage-trip
 * Given km + optional claim_id, compute the rand amount using the company's
 * SARS prescribed rate and (when claim_id is given) add it as a mileage
 * line. Returns the computed line without a claim when claim_id is omitted,
 * so the PWA can preview the amount before asking the user to confirm.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import {
  getCompanyKmRate,
  computeMileageAmount,
  addLine,
} from '@/modules/accounting/services/expense/expenseClaimService';

type GlRow = { id: string };

async function findDefaultMileageAccount(companyId: string): Promise<string | null> {
  // Prefer anything named "travel" / "motor" / "mileage"; fall back to the
  // first active expense account. Callers can override per-line.
  const rows = (await sql`
    SELECT id FROM gl_accounts
    WHERE company_id = ${companyId}::uuid AND is_active = true AND account_type = 'expense'
      AND (
        account_name ILIKE '%travel%'
        OR account_name ILIKE '%motor%'
        OR account_name ILIKE '%mileage%'
        OR account_name ILIKE '%transport%'
      )
    ORDER BY level DESC, display_order ASC
    LIMIT 1
  `) as GlRow[];
  if (rows[0]) return rows[0].id;
  const fallback = (await sql`
    SELECT id FROM gl_accounts
    WHERE company_id = ${companyId}::uuid AND is_active = true AND account_type = 'expense'
    ORDER BY level DESC, display_order ASC
    LIMIT 1
  `) as GlRow[];
  return fallback[0]?.id ?? null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Body {
  claimId?: string;
  km?: number;
  tripDate?: string;
  from?: string;
  to?: string;
  description?: string;
  projectId?: string;
  costCentreId?: string;
  glAccountId?: string;
  mileageRoute?: Record<string, unknown>;
}

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? '', ['POST']);
  const { companyId } = req;
  const body = (req.body ?? {}) as Body;
  if (!body.km || body.km <= 0) return apiResponse.badRequest(res, 'km must be positive');

  const rate = await getCompanyKmRate(companyId);
  const amount = computeMileageAmount(body.km, rate);
  const tripDate = body.tripDate ?? new Date().toISOString().slice(0, 10);
  const glAccountId = body.glAccountId ?? (await findDefaultMileageAccount(companyId));

  const linePayload = {
    lineDate: tripDate,
    description: body.description ?? (body.from && body.to ? `Mileage ${body.from} → ${body.to}` : 'Mileage'),
    merchant: null,
    amount,
    vatAmount: 0,                       // Mileage is VAT-exempt per SARS
    vatCode: 'EXEMPT',
    glAccountId,
    costCentreId: body.costCentreId ?? null,
    projectId: body.projectId ?? null,
    sourceDocumentId: null,
    kmTravelled: body.km,
    kmRate: rate,
    mileageFrom: body.from ?? null,
    mileageTo: body.to ?? null,
  };

  if (body.claimId && UUID_RE.test(body.claimId)) {
    try {
      const claim = await addLine(body.claimId, companyId, linePayload);
      if (!claim) return apiResponse.notFound(res, 'Expense claim', body.claimId);
      return apiResponse.success(res, { claim, line: linePayload, rate });
    } catch (err) {
      return apiResponse.badRequest(res, err instanceof Error ? err.message : String(err));
    }
  }

  return apiResponse.success(res, { preview: linePayload, rate, amount });
}

export default withAuth(withErrorHandler(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0])));
