/**
 * Company Groups API
 * GET    — list groups / get single group
 * POST   — create group / add member / manage COA
 * PUT    — update group / update member
 * DELETE — remove member / delete group
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { sql } from '@/lib/neon';
import {
  userBelongsToCompany,
  userBelongsToGroup,
} from '@/modules/accounting/services/core/companyAccessService';
import {
  getGroup,
  createGroup,
  updateGroup,
  deleteGroup,
  addMember,
  updateMember,
  removeMember,
  getGroupMembers,
  getGroupAccounts,
  createGroupAccount,
  updateGroupAccount,
  deleteGroupAccount,
  autoGenerateGroupCOA,
  getCoaMappings,
  setCoaMapping,
  removeCoaMapping,
  autoMapAccounts,
  getUnmappedAccounts,
} from '@/modules/accounting/services/reports/groupCompanyService';

// Uses withAuth (not withAuth) because group operations span multiple companies.
// Security is provided by verifyGroupAccess() before every operation — groupId is
// always validated against company_group_members joined with company_users.
async function handler(req: NextApiRequest, res: NextApiResponse) {
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  const action = (req.query.action || req.body?.action) as string | undefined;

  // Both guards delegate to companyAccessService. They used to be inline copies
  // that compared company_users.user_id (text) to a ::UUID cast, so every
  // guarded action on this route 500'd — including adding the first member,
  // which left a newly created group permanently orphaned.
  const verifyGroupAccess = (gId: string) => userBelongsToGroup(userId, gId);

  // Verify the user is a member of a SPECIFIC company. Body-supplied companyIds
  // (add-member / auto-generate-coa / set-mapping / auto-map) must be gated by this
  // so a group member cannot pull an unrelated tenant's company into the group and
  // read its COA/financials (pentest H1 — cross-tenant IDOR).
  const verifyCompanyMembership = (cId: string) => userBelongsToCompany(userId, cId);

  // ── GET ────────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const groupId = req.query.group_id as string | undefined;

    if (action === 'members' && groupId) {
      if (!(await verifyGroupAccess(groupId))) return apiResponse.forbidden(res, 'Access denied to this group');
      const members = await getGroupMembers(groupId);
      return apiResponse.success(res, { items: members });
    }

    if (action === 'accounts' && groupId) {
      if (!(await verifyGroupAccess(groupId))) return apiResponse.forbidden(res, 'Access denied to this group');
      const accounts = await getGroupAccounts(groupId);
      return apiResponse.success(res, { items: accounts });
    }

    if (action === 'mappings' && groupId) {
      const companyId = req.query.company_id as string | undefined;
      if (companyId) {
        const membership = (await verifyCompanyMembership(companyId)) ? [true] : [];
        if (!membership[0]) return apiResponse.forbidden(res, 'Access denied to the specified company');
      }
      const mappings = await getCoaMappings(groupId, companyId);
      return apiResponse.success(res, { items: mappings });
    }

    if (action === 'unmapped' && groupId) {
      const companyId = req.query.company_id as string;
      if (!companyId) return apiResponse.badRequest(res, 'company_id required');
      const membership = (await verifyCompanyMembership(companyId)) ? [true] : [];
      if (!membership[0]) return apiResponse.forbidden(res, 'Access denied to the specified company');
      const unmapped = await getUnmappedAccounts(groupId, companyId);
      return apiResponse.success(res, { items: unmapped });
    }

    if (groupId) {
      if (!(await verifyGroupAccess(groupId))) return apiResponse.forbidden(res, 'Access denied to this group');
      const group = await getGroup(groupId);
      if (!group) return apiResponse.notFound(res, 'Group');
      return apiResponse.success(res, group);
    }

    const groups = (await sql`
      SELECT cg.*, COUNT(cgm2.id) FILTER (WHERE cgm2.left_date IS NULL)::int AS member_count
      FROM company_groups cg
      JOIN company_group_members cgm ON cgm.group_id = cg.id
      JOIN company_users cu ON cu.company_id::TEXT = cgm.company_id::TEXT
      LEFT JOIN company_group_members cgm2 ON cgm2.group_id = cg.id
      WHERE cu.user_id::TEXT = ${userId} AND cg.is_active = true
      GROUP BY cg.id
      ORDER BY cg.name
    `) as Record<string, unknown>[];
    return apiResponse.success(res, { items: groups });
  }

  // ── POST ───────────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    if (action === 'add-member') {
      const { groupId, companyId, ownershipPct, consolidationMethod } = req.body;
      if (!groupId || !companyId) return apiResponse.badRequest(res, 'groupId and companyId required');
      if (!(await verifyGroupAccess(groupId))) return apiResponse.forbidden(res, 'Access denied to this group');
      if (!(await verifyCompanyMembership(companyId))) return apiResponse.forbidden(res, 'Access denied to the specified company');
      const member = await addMember(groupId, companyId, {
        ownershipPct: ownershipPct ?? 100,
        consolidationMethod: consolidationMethod ?? 'full',
      });
      return apiResponse.success(res, member);
    }

    if (action === 'create-group-account') {
      const { groupId, accountCode, accountName, accountType, accountSubtype, parentAccountId, normalBalance, level, displayOrder } = req.body;
      if (!groupId || !accountCode || !accountName || !accountType) {
        return apiResponse.badRequest(res, 'groupId, accountCode, accountName, accountType required');
      }
      if (!(await verifyGroupAccess(groupId))) return apiResponse.forbidden(res, 'Access denied to this group');
      const account = await createGroupAccount(groupId, {
        accountCode, accountName, accountType, accountSubtype, parentAccountId, normalBalance, level, displayOrder,
      });
      return apiResponse.success(res, account);
    }

    if (action === 'auto-generate-coa') {
      const { groupId, sourceCompanyId } = req.body;
      if (!groupId || !sourceCompanyId) return apiResponse.badRequest(res, 'groupId and sourceCompanyId required');
      if (!(await verifyGroupAccess(groupId))) return apiResponse.forbidden(res, 'Access denied to this group');
      if (!(await verifyCompanyMembership(sourceCompanyId))) return apiResponse.forbidden(res, 'Access denied to the specified company');
      const count = await autoGenerateGroupCOA(groupId, sourceCompanyId);
      return apiResponse.success(res, { accountsCreated: count });
    }

    if (action === 'set-mapping') {
      const { groupId, companyId, companyAccountId, groupAccountId } = req.body;
      if (!groupId || !companyId || !companyAccountId || !groupAccountId) {
        return apiResponse.badRequest(res, 'groupId, companyId, companyAccountId, groupAccountId required');
      }
      if (!(await verifyGroupAccess(groupId))) return apiResponse.forbidden(res, 'Access denied to this group');
      if (!(await verifyCompanyMembership(companyId))) return apiResponse.forbidden(res, 'Access denied to the specified company');
      const mapping = await setCoaMapping(groupId, companyId, companyAccountId, groupAccountId);
      return apiResponse.success(res, mapping);
    }

    if (action === 'auto-map') {
      const { groupId, companyId } = req.body;
      if (!groupId || !companyId) return apiResponse.badRequest(res, 'groupId and companyId required');
      if (!(await verifyGroupAccess(groupId))) return apiResponse.forbidden(res, 'Access denied to this group');
      if (!(await verifyCompanyMembership(companyId))) return apiResponse.forbidden(res, 'Access denied to the specified company');
      const count = await autoMapAccounts(groupId, companyId);
      return apiResponse.success(res, { mappedCount: count });
    }

    // Default POST: create group
    const { name, holdingCompanyId, defaultCurrency, financialYearStart } = req.body;
    if (!name) return apiResponse.badRequest(res, 'name is required');
    // createGroup auto-enrolls holdingCompanyId as a group member, so it is the same
    // cross-tenant injection vector as add-member — gate it on caller membership (H1).
    if (holdingCompanyId && !(await verifyCompanyMembership(holdingCompanyId))) {
      return apiResponse.forbidden(res, 'Access denied to the specified holding company');
    }
    const group = await createGroup({ name, holdingCompanyId, defaultCurrency, financialYearStart }, userId);
    return apiResponse.success(res, group);
  }

  // ── PUT ────────────────────────────────────────────────────────────────────
  if (req.method === 'PUT') {
    if (action === 'update-member') {
      const { memberId, groupId: memberGroupId, ownershipPct, consolidationMethod } = req.body;
      if (!memberId) return apiResponse.badRequest(res, 'memberId required');
      if (!memberGroupId) return apiResponse.badRequest(res, 'groupId required');
      if (!(await verifyGroupAccess(memberGroupId))) return apiResponse.forbidden(res, 'Access denied to this group');
      await updateMember(memberId, { ownershipPct, consolidationMethod }, memberGroupId);
      return apiResponse.success(res, { updated: true });
    }

    if (action === 'update-group-account') {
      const { accountId, groupId: accountGroupId, ...updates } = req.body;
      if (!accountId) return apiResponse.badRequest(res, 'accountId required');
      if (!accountGroupId) return apiResponse.badRequest(res, 'groupId required');
      if (!(await verifyGroupAccess(accountGroupId))) return apiResponse.forbidden(res, 'Access denied to this group');
      const account = await updateGroupAccount(accountId, updates, accountGroupId);
      return apiResponse.success(res, account);
    }

    const { groupId, ...updates } = req.body;
    if (!groupId) return apiResponse.badRequest(res, 'groupId required');
    if (!(await verifyGroupAccess(groupId))) return apiResponse.forbidden(res, 'Access denied to this group');
    const group = await updateGroup(groupId, updates);
    return apiResponse.success(res, group);
  }

  // ── DELETE ─────────────────────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    if (action === 'remove-member') {
      const memberId = req.query.member_id as string;
      const groupId = req.query.group_id as string;
      if (!memberId) return apiResponse.badRequest(res, 'member_id required');
      if (!groupId) return apiResponse.badRequest(res, 'group_id required');
      if (!(await verifyGroupAccess(groupId))) return apiResponse.forbidden(res, 'Access denied to this group');
      await removeMember(memberId, groupId);
      return apiResponse.success(res, { removed: true });
    }

    if (action === 'remove-mapping') {
      const mappingId = req.query.mapping_id as string;
      const groupId = req.query.group_id as string;
      if (!mappingId) return apiResponse.badRequest(res, 'mapping_id required');
      if (!groupId) return apiResponse.badRequest(res, 'group_id required');
      if (!(await verifyGroupAccess(groupId))) return apiResponse.forbidden(res, 'Access denied to this group');
      await removeCoaMapping(mappingId, groupId);
      return apiResponse.success(res, { removed: true });
    }

    if (action === 'delete-group-account') {
      const accountId = req.query.account_id as string;
      const groupId = req.query.group_id as string;
      if (!accountId) return apiResponse.badRequest(res, 'account_id required');
      if (!groupId) return apiResponse.badRequest(res, 'group_id required');
      if (!(await verifyGroupAccess(groupId))) return apiResponse.forbidden(res, 'Access denied to this group');
      await deleteGroupAccount(accountId, groupId);
      return apiResponse.success(res, { deleted: true });
    }

    const groupId = req.query.group_id as string;
    if (!groupId) return apiResponse.badRequest(res, 'group_id required');
    if (!(await verifyGroupAccess(groupId))) return apiResponse.forbidden(res, 'Access denied to this group');
    await deleteGroup(groupId);
    return apiResponse.success(res, { deleted: true });
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST', 'PUT', 'DELETE']);
}

 
export default withAuth(withErrorHandler(withCsrf(handler)));
