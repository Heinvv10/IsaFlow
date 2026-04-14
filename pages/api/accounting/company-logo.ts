/**
 * POST /api/accounting/company-logo
 * Upload/update company logo as a base64 data URL.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
type Row = Record<string, unknown>;


/**
 * AUTH: Uses withAuth (not withCompany) because a user may own/admin multiple companies
 * and this endpoint accepts an explicit companyId in the request body. Tenant scoping is
 * enforced by a membership check against company_users (owner/admin role required) before
 * any write is performed — no cross-tenant write is possible.
 * See docs/audits/2026-04-14/04-code-quality.md#Q-005 for rationale.
 */
async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method!, ['POST']);
  }

  const userId = (req as AuthenticatedNextApiRequest).user.id;
  const { companyId, logoData } = req.body as {
    companyId?: string;
    logoData?: string;
  };

  if (!companyId) return apiResponse.badRequest(res, 'companyId is required');
  if (!logoData) return apiResponse.badRequest(res, 'logoData is required');

  // Validate ownership (owner or admin)
  const membership = (await sql`
    SELECT role FROM company_users
    WHERE company_id = ${companyId}::UUID AND user_id = ${userId}
  `) as Row[];

  if (membership.length === 0) {
    return apiResponse.forbidden(res, 'You do not have access to this company');
  }
  if (!['owner', 'admin'].includes(String(membership[0]!.role))) {
    return apiResponse.forbidden(res, 'Only owners and admins can update the company logo');
  }

  // Validate data URL format
  if (!logoData.startsWith('data:image/')) {
    return apiResponse.badRequest(res, 'logoData must be a valid data:image/ URL');
  }

  // Validate size < 5MB (base64 is ~1.33x raw, so 5MB raw ~ 6.8M chars)
  if (logoData.length > 6_800_000) {
    return apiResponse.badRequest(res, 'Logo must be smaller than 5MB');
  }

  await sql`
    UPDATE companies SET logo_data = ${logoData} WHERE id = ${companyId}::UUID
  `;

  return apiResponse.success(res, { updated: true });
}

 
export default withAuth(withErrorHandler(handler));

export const config = {
  api: { bodyParser: { sizeLimit: '10mb' } },
};
