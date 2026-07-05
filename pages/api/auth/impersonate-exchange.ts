/**
 * Impersonation Token Exchange
 * GET /api/auth/impersonate-exchange?token=<jwt>
 *
 * Validates a short-lived impersonation JWT (created by POST /api/admin/companies/[id]/impersonate)
 * and returns the target company info. Must be called by an authenticated super_admin.
 *
 * The accounting page calls this with the ?impersonate= query param, stores the company
 * in localStorage, and re-initialises CompanyContext to browse as the target company.
 */

import type { NextApiResponse } from 'next';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { setActiveCompanyCookie } from '@/lib/auth/cookies';
import { withAuth } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { validateImpersonationToken } from '@/modules/admin/services/impersonationService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  // Platform role check — pentest H9. The previous check read `companyRole`
  // from `company_users.role` (owner/admin/accountant/user/viewer), which can
  // never equal 'super_admin'; the endpoint always denied. Now we check the
  // platform-level `users.role`.
  const platformRoleRows = await sql<{ role: string }>`
    SELECT role FROM users WHERE id = ${req.user.id} LIMIT 1
  `;
  const platformRole = platformRoleRows[0]?.role;
  if (platformRole !== 'super_admin') {
    return apiResponse.forbidden(res, 'Only super_admin can use impersonation');
  }

  const token = req.query.token as string | undefined;
  if (!token) {
    return apiResponse.badRequest(res, 'Missing token parameter');
  }

  const payload = await validateImpersonationToken(token);
  if (!payload) {
    return apiResponse.badRequest(res, 'Invalid or expired impersonation token');
  }

  if (payload.admin_user_id !== req.user.id) {
    log.warn('Impersonation token user mismatch', { tokenAdminId: payload.admin_user_id, requestUserId: req.user.id }, 'impersonate-exchange');
    return apiResponse.forbidden(res, 'Impersonation token does not match your session');
  }

  try {
    // W7 (P2.4): previously this returned only the label — the frontend wrote
    // localStorage while the active_company cookie (which withAuth actually
    // scopes every query by) still pointed at the admin's own company: the
    // impersonated company's NAME over the wrong company's DATA.
    //
    // Membership is checked FIRST: under RLS the companies table is only
    // visible to members (companies_member_read mirrors this exact join), so
    // a company lookup for a non-member returns 0 rows and would masquerade
    // as a misleading 404. company_users rows for the caller ARE visible
    // under RLS, making this check reachable and honest. withAuth
    // hard-requires membership on every later request anyway (no
    // super_admin bypass, by design) — never set a label-only response.
    const membership = await sql`
      SELECT 1 FROM company_users
      WHERE user_id = ${req.user.id} AND company_id = ${payload.company_id}::UUID
      LIMIT 1
    `;
    if (membership.length === 0) {
      return apiResponse.forbidden(
        res,
        'You are not a member of this company — use user-impersonation (admin platform → Users → Impersonate), which signs you in as an actual member',
      );
    }

    const rows = await sql`
      SELECT id, name FROM companies WHERE id = ${payload.company_id}::UUID LIMIT 1
    `;
    if (rows.length === 0) {
      return apiResponse.notFound(res, 'Company not found');
    }

    const company = rows[0]!;
    setActiveCompanyCookie(res, String(company.id));
    return apiResponse.success(res, {
      company_id: company.id as string,
      company_name: company.name as string,
    });
  } catch (err) {
    log.error('impersonate-exchange: DB error', { error: err }, 'impersonate-exchange');
    return apiResponse.internalError(res, 'Failed to look up company');
  }
}

export default withAuth(withErrorHandler(handler));
