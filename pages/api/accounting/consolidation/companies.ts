/**
 * Consolidation: Group Companies API
 * GET  — list parent + direct subsidiaries for the current company
 * POST — add a subsidiary relationship (the caller must be a member of the child
 *        company: consolidated reads cross company_id, so an unchecked child is
 *        a full cross-tenant GL leak)
 * DELETE — withdraw a subsidiary relationship (soft delete, migration 531)
 *
 * The two write methods are deliberately gated differently. POST creates a
 * cross-tenant read grant, so it is gated on membership of the CHILD — the
 * tenant whose ledger becomes visible. DELETE only revokes such a grant, so it
 * is gated on the PARENT alone, enforced by scoping the write to the caller's
 * authenticated companyId. Requiring child access to revoke would strand a link
 * created in error — or by someone since removed from the child — with no way
 * back short of raw SQL, leaving the GL exposed. Revocation must never be
 * harder than creation. The CHILD side may withdraw too (D4 round 10): with the
 * child as the active company, DELETE ?parentCompanyId= removes the link that
 * exposes it, so its own owners can end a grant someone else made.
 *
 * Every id is UUID-checked (typeof first) before any ::UUID cast (400).
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import {
  getGroupCompanies,
  createCompanyRelationship,
  deleteCompanyRelationship,
} from '@/modules/accounting/services/reports/consolidationService';
import { userCanWriteCompany } from '@/modules/accounting/services/core/companyAccessService';
import { sql } from '@/lib/neon';
import { isUuidParam } from '@/lib/validation';
import type { DbRow } from '@/lib/neon';

type Row = DbRow;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;

  if (req.method === 'GET') {
    const items = await getGroupCompanies(companyId);
    return apiResponse.success(res, { items });
  }

  if (req.method === 'POST') {
    const {
      childCompanyId,
      ownershipPercent = 100,
      relationshipType = 'subsidiary',
    } = req.body as {
      childCompanyId?: string;
      ownershipPercent?: number;
      relationshipType?: string;
    };

    if (!childCompanyId) {
      return apiResponse.badRequest(res, 'childCompanyId is required');
    }
    if (!isUuidParam(childCompanyId)) return apiResponse.badRequest(res, 'childCompanyId must be a valid UUID');

    // Verify the child company exists
    const exists = (await sql`
      SELECT id FROM companies WHERE id = ${childCompanyId}::UUID LIMIT 1
    `) as Row[];

    if (exists.length === 0) {
      return apiResponse.notFound(res, 'Child company not found');
    }

    // Existence is NOT authorisation. consolidation/trial-balance and
    // consolidation/intercompany-balances aggregate every child's GL, so
    // attaching a company the caller does not belong to reads that tenant's
    // whole ledger. 403 (not 404) — the company demonstrably exists.
    // A write role in the child, not membership: attaching it publishes its ledger (D4 round 9).
    if (!(await userCanWriteCompany(userId, childCompanyId))) {
      log.warn(
        'Refused subsidiary link to a company the user holds no write role in',
        { companyId, childCompanyId, userId },
        'consolidation-api',
      );
      return apiResponse.forbidden(res, 'Access denied to the specified child company');
    }

    try {
      await createCompanyRelationship(
        companyId,
        childCompanyId,
        Number(ownershipPercent),
        userId,
        relationshipType,
      );
      const items = await getGroupCompanies(companyId);
      return apiResponse.success(res, { items });
    } catch (err) {
      log.error('Failed to create company relationship', { companyId, childCompanyId, error: err }, 'consolidation-api');
      return apiResponse.badRequestFromError(res, err, 'Failed to create relationship');
    }
  }

  if (req.method === 'DELETE') {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const childCompanyId: unknown = req.query.childCompanyId ?? body.childCompanyId;
    const parentCompanyId: unknown = req.query.parentCompanyId ?? body.parentCompanyId;

    if (childCompanyId !== undefined && parentCompanyId !== undefined) {
      return apiResponse.badRequest(res, 'Give childCompanyId (as the parent) or parentCompanyId (as the child), not both');
    }
    if (childCompanyId === undefined && parentCompanyId === undefined) {
      return apiResponse.badRequest(res, 'childCompanyId is required');
    }
    const other = childCompanyId ?? parentCompanyId;
    if (!isUuidParam(other)) {
      return apiResponse.badRequest(res, `${childCompanyId !== undefined ? 'childCompanyId' : 'parentCompanyId'} must be a valid UUID`);
    }

    // companyId comes from withAuth (and withWriteAccess holds a write role in it), so it IS the
    // authorisation: as the parent it withdraws a subsidiary, as the child it withdraws itself.
    // The UPDATE matches nothing for any other pair.
    const asParent = childCompanyId !== undefined;
    const removed = asParent
      ? await deleteCompanyRelationship(companyId, other, userId)
      : await deleteCompanyRelationship(other, companyId, userId);

    if (!removed) {
      return apiResponse.notFound(res, 'No active subsidiary relationship found');
    }

    log.info('Subsidiary relationship withdrawn', { companyId, other, asParent, userId }, 'consolidation-api');
    const items = await getGroupCompanies(companyId);
    return apiResponse.success(res, { items });
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST', 'DELETE']);
}

// POST / DELETE change the ACTIVE company's subsidiaries (it is the parent), so its own role
// decides: withWriteAccess refuses a viewer with 403. GET passes through.
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler as Parameters<typeof withAuth>[0]))));
