/**
 * POST /api/accounting/company-logo
 * Upload/update company logo as a base64 data URL.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { sql } from '@/lib/neon';
import { UUID } from '@/lib/schemas/common';
type Row = Record<string, unknown>;

// Pentest M14: accept only safe raster formats. Excludes data:image/svg+xml
// (can embed <script>), data:image/xml, and arbitrary "image/*" subtypes.
const LOGO_DATA_URL_RE = /^data:image\/(jpeg|png|gif|webp);base64,[A-Za-z0-9+/=\s]+$/;

const CompanyLogoSchema = z.object({
  companyId: UUID,
  logoData: z.string()
    .min(1)
    .max(6_800_000, 'Logo must be smaller than 5MB')
    .regex(LOGO_DATA_URL_RE, 'Logo must be a base64 PNG, JPEG, GIF, or WebP data URL'),
});


/**
 * AUTH: Uses withAuth (not withAuth) because a user may own/admin multiple companies
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

  const parsed = CompanyLogoSchema.safeParse(req.body);
  if (!parsed.success) {
    return apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
  }
  const { companyId, logoData } = parsed.data;

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

  await sql`
    UPDATE companies SET logo_data = ${logoData} WHERE id = ${companyId}::UUID
  `;

  return apiResponse.success(res, { updated: true });
}

 
export default withAuth(withErrorHandler(withCsrf(handler)));

export const config = {
  api: { bodyParser: { sizeLimit: '10mb' } },
};
