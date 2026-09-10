/**
 * Companies API
 * GET  — list companies for current user
 * POST — create a new company
 * PUT  — update company details
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { signingInvalidationWarnings } from '@/modules/accounting/services/afs/afsSigningIntegrity';
import {
  getCompany, createCompany, updateCompany,
  getUserCompanies, setDefaultCompany,
} from '@/modules/accounting/services/core/companyService';

/**
 * AUTH: Uses withAuth (not withAuth) because this endpoint manages the list of
 * companies a user belongs to — it is intentionally cross-company. All reads are scoped
 * to getUserCompanies(userId), which filters by the authenticated user's company_users
 * rows. Any access to a specific company (GET ?id=, PUT, POST set-default) is guarded by
 * a membership check verifying the user belongs to that company. Super-admin access to
 * arbitrary company records is explicitly gated on role === 'super_admin'.
 * See docs/audits/2026-04-14/04-code-quality.md#Q-005 for rationale.
 */
/**
 * `vat_period` is free text in the schema and is read by the VAT signals via
 * normalizeVatSetting, which silently treats anything unrecognised as
 * bi-monthly. Reject junk at the door instead of filing VAT201 reminders for a
 * company whose cadence was a typo. 'none' = not a VAT vendor.
 */
const VALID_VAT_PERIODS = ['monthly', 'bi-monthly', 'none'];
export function isValidVatPeriod(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  return typeof value === 'string' && VALID_VAT_PERIODS.includes(value.trim().toLowerCase());
}

/**
 * `vat_system_type` is the other half of the pair — it is the column
 * `normalizeVatSetting` reads for the 'none' (not-a-VAT-vendor) flag. An
 * unrecognised value there reads as "registered", so junk must be rejected
 * here too or the two columns silently disagree.
 */
const VALID_VAT_SYSTEM_TYPES = ['invoice', 'payment', 'none'];
export function isValidVatSystemType(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  return typeof value === 'string' && VALID_VAT_SYSTEM_TYPES.includes(value.trim().toLowerCase());
}

async function registeredIdentity(companyId: string): Promise<{ name: string | null; registration_number: string | null }> {
  const rows = (await sql`
    SELECT name, registration_number FROM companies WHERE id = ${companyId}::UUID
  `) as Array<{ name: string | null; registration_number: string | null }>;
  return rows[0] ?? { name: null, registration_number: null };
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const userId = (req as AuthenticatedNextApiRequest).user.id;

  if (req.method === 'GET') {
    if (req.query.action === 'user-companies') {
      const companies = await getUserCompanies(userId);
      return apiResponse.success(res, { items: companies });
    }
    if (req.query.id) {
      // super_admin can access any company (impersonation / support access)
      const isSuperAdmin = (req as CompanyAuthedRequest).companyRole === 'super_admin';
      if (!isSuperAdmin) {
        const userCompanies = await getUserCompanies(userId);
        const hasAccess = userCompanies.some(c => c.companyId === req.query.id);
        if (!hasAccess) return apiResponse.forbidden(res, 'You do not have access to this company');
      } else {
        log.warn('super_admin company access bypass', {
          action: 'super_admin_company_access',
          userId,
          targetCompanyId: req.query.id as string,
          timestamp: new Date().toISOString(),
        }, 'audit');
      }
      const company = await getCompany(req.query.id as string);
      if (!company) return apiResponse.notFound(res, 'Company');
      return apiResponse.success(res, company);
    }
    // Default: only return companies the user belongs to
    const companies = await getUserCompanies(userId);
    return apiResponse.success(res, { items: companies });
  }

  if (req.method === 'POST') {
    if (req.body.action === 'set-default') {
      // Verify membership before setting default
      const userCompanies = await getUserCompanies(userId);
      if (!userCompanies.some(c => c.companyId === req.body.companyId)) {
        return apiResponse.forbidden(res, 'You do not have access to this company');
      }
      await setDefaultCompany(userId, req.body.companyId);
      return apiResponse.success(res, { success: true });
    }
    const {
      name, tradingName, registrationNumber, vatNumber, taxNumber, email, phone,
      website, addressLine1, addressLine2, city, province, postalCode, country,
      logoData, bankName, bankAccountNumber, bankBranchCode, bankAccountType,
      financialYearStart, vatPeriod, vatSystemType, defaultCurrency,
    } = req.body;
    if (!name) return apiResponse.badRequest(res, 'name is required');
    if (!isValidVatPeriod(vatPeriod)) {
      return apiResponse.badRequest(res, "vatPeriod must be 'monthly', 'bi-monthly' or 'none'");
    }
    if (!isValidVatSystemType(vatSystemType)) {
      return apiResponse.badRequest(res, "vatSystemType must be 'invoice', 'payment' or 'none'");
    }
    const company = await createCompany(
      {
        name, tradingName, registrationNumber, vatNumber, taxNumber, email, phone,
        website, addressLine1, addressLine2, city, province, postalCode, country,
        logoData, bankName, bankAccountNumber, bankBranchCode, bankAccountType,
        financialYearStart, vatPeriod, vatSystemType, defaultCurrency,
      },
      userId
    );
    return apiResponse.success(res, company);
  }

  if (req.method === 'PUT') {
    const { id, ...updates } = req.body;
    if (!id) return apiResponse.badRequest(res, 'id is required');
    if (!isValidVatPeriod(updates.vatPeriod)) {
      return apiResponse.badRequest(res, "vatPeriod must be 'monthly', 'bi-monthly' or 'none'");
    }
    if (!isValidVatSystemType(updates.vatSystemType)) {
      return apiResponse.badRequest(res, "vatSystemType must be 'invoice', 'payment' or 'none'");
    }
    // Verify user is owner or admin of this company
    const userCompanies = await getUserCompanies(userId);
    const membership = userCompanies.find(c => c.companyId === id);
    if (!membership) return apiResponse.forbidden(res, 'You do not have access to this company');
    if (!['owner', 'admin'].includes(membership.role)) {
      return apiResponse.forbidden(res, 'Only owners and admins can update company details');
    }
    // The registered name and number are printed on the statements' cover. Changing them is the
    // company's right while a document is out for signature, but it voids that signature — so
    // warn when, and only when, one of them actually changed (the settings page PUTs the whole
    // object on every save).
    const before = await registeredIdentity(id);
    const company = await updateCompany(id, updates);
    const after = await registeredIdentity(id);
    const warnings = before.name !== after.name || before.registration_number !== after.registration_number
      ? await signingInvalidationWarnings(sql, id, 'the registered company name or number')
      : [];
    return apiResponse.success(res, { ...company, warnings });
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST', 'PUT']);
}

 
export default withAuth(withErrorHandler(withCsrf(handler)));

export const config = {
  api: { bodyParser: { sizeLimit: '10mb' } },
};
