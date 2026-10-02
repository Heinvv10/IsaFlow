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
import {
  userBelongsToGroup,
  userCanWriteCompany,
  userCanWriteGroup,
} from '@/modules/accounting/services/core/companyAccessService';
import {
  COMPANY_CHART_REFUSED, creatorMayBootstrapGroup, groupRequestError, mappingAccountsBelong, mappingCompanyId,
  refuseGroupCompanyRead, refuseGroupCompanyWrite, type Refusal,
} from '@/modules/accounting/services/core/groupRouteGuards';
import {
  getGroup,
  listGroupsForUser,
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

// Uses withAuth (not withCompany) because group operations span multiple companies.
// Security is provided by verifyGroupAccess() before every operation — groupId is
// always validated against company_group_members joined with company_users.
async function handler(req: NextApiRequest, res: NextApiResponse) {
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  const action = (req.query.action || req.body?.action) as string | undefined;
  // An unknown action is refused on every method (DELETE used to fall through to delete-group),
  // and every id is UUID-checked before any ::UUID cast, whatever the action; see groupRouteGuards.
  const requestError = groupRequestError(req.method ?? '', action, req.query, req.body);
  if (requestError) return apiResponse.badRequest(res, requestError);
  const refuse = (r: Refusal) => (r.status === 400 ? apiResponse.badRequest(res, r.message) : apiResponse.forbidden(res, r.message));

  // Guards delegate to companyAccessService / groupRouteGuards (inline copies once 500'd on a text = uuid cast).
  const verifyGroupAccess = (gId: string) => userBelongsToGroup(userId, gId);
  // Body-supplied companyIds are never trusted (pentest H1, cross-tenant IDOR). Putting a company into a group (member or holding) exposes its ledger to the whole group:
  // that needs a WRITE role in the company itself, not just membership (D4 round 9).
  const COMPANY_WRITE_REFUSED = 'Adding a company to a group needs an owner, admin or manager role in that company.';

  // Every POST / PUT / DELETE on an existing group changes what the consolidation
  // reports (members, ownership, group chart, mappings), so it needs a group WRITE role:
  // owner / admin / manager of a current member company (userCanWriteGroup). Membership
  // alone (any role, incl. viewer) still reads. 403 for a member, 'Access denied' otherwise.
  const refuseGroupWrite = async (gId: string): Promise<string | null> => {
    if (!(await verifyGroupAccess(gId))) return 'Access denied to this group';
    return (await userCanWriteGroup(userId, gId)) ? null : 'Your role in this group does not allow this change.';
  };

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
      if (!(await verifyGroupAccess(groupId))) return apiResponse.forbidden(res, 'Access denied to this group');
      const companyId = req.query.company_id as string | undefined;
      const refused = companyId ? await refuseGroupCompanyRead(userId, groupId, companyId) : null;
      if (refused) return refuse(refused);
      const mappings = await getCoaMappings(groupId, companyId);
      return apiResponse.success(res, { items: mappings });
    }

    if (action === 'unmapped' && groupId) {
      const companyId = req.query.company_id as string;
      if (!companyId) return apiResponse.badRequest(res, 'company_id required');
      if (!(await verifyGroupAccess(groupId))) return apiResponse.forbidden(res, 'Access denied to this group');
      const refused = await refuseGroupCompanyRead(userId, groupId, companyId);
      if (refused) return refuse(refused);
      const unmapped = await getUnmappedAccounts(groupId, companyId);
      return apiResponse.success(res, { items: unmapped });
    }

    if (groupId) {
      if (!(await verifyGroupAccess(groupId))) return apiResponse.forbidden(res, 'Access denied to this group');
      const group = await getGroup(groupId);
      if (!group) return apiResponse.notFound(res, 'Group');
      return apiResponse.success(res, group);
    }

    // Scoped in listGroupsForUser: member-company membership OR group creator.
    // The creator clause is what stops a memberless group from being orphaned.
    const groups = await listGroupsForUser(userId);
    return apiResponse.success(res, { items: groups });
  }

  // ── POST ───────────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    if (action === 'add-member') {
      const { groupId, companyId, ownershipPct, consolidationMethod } = req.body;
      if (!groupId || !companyId) return apiResponse.badRequest(res, 'groupId and companyId required');
      // A group member needs a write role. The creator may bootstrap a group with no members
      // (it could never gain its first one otherwise) only while every member is a company they
      // still belong to. userCanWriteCompany below still bars a foreign or view-only company.
      const mayAddMember =
        (await userCanWriteGroup(userId, groupId)) || (await creatorMayBootstrapGroup(userId, groupId));
      if (!mayAddMember) {
        const member = await verifyGroupAccess(groupId);
        return apiResponse.forbidden(res, member ? 'Your role in this group does not allow this change.' : 'Access denied to this group');
      }
      if (!(await userCanWriteCompany(userId, companyId))) return apiResponse.forbidden(res, COMPANY_WRITE_REFUSED);
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
      const refused = await refuseGroupWrite(groupId);
      if (refused) return apiResponse.forbidden(res, refused);
      const account = await createGroupAccount(groupId, {
        accountCode, accountName, accountType, accountSubtype, parentAccountId, normalBalance, level, displayOrder,
      });
      return apiResponse.success(res, account);
    }

    if (action === 'auto-generate-coa') {
      const { groupId, sourceCompanyId } = req.body;
      if (!groupId || !sourceCompanyId) return apiResponse.badRequest(res, 'groupId and sourceCompanyId required');
      const refused = await refuseGroupWrite(groupId);
      if (refused) return apiResponse.forbidden(res, refused);
      const refusedCompany = await refuseGroupCompanyWrite(userId, groupId, sourceCompanyId);
      if (refusedCompany) return refuse(refusedCompany);
      const count = await autoGenerateGroupCOA(groupId, sourceCompanyId);
      return apiResponse.success(res, { accountsCreated: count });
    }

    if (action === 'set-mapping') {
      const { groupId, companyId, companyAccountId, groupAccountId } = req.body;
      if (!groupId || !companyId || !companyAccountId || !groupAccountId) {
        return apiResponse.badRequest(res, 'groupId, companyId, companyAccountId, groupAccountId required');
      }
      const refused = await refuseGroupWrite(groupId);
      if (refused) return apiResponse.forbidden(res, refused);
      const refusedCompany = await refuseGroupCompanyWrite(userId, groupId, companyId);
      if (refusedCompany) return refuse(refusedCompany);
      const owned = await mappingAccountsBelong(companyId, companyAccountId, groupId, groupAccountId);
      if (!owned.company) return apiResponse.badRequest(res, 'companyAccountId is not an account of that company');
      if (!owned.group) return apiResponse.badRequest(res, 'groupAccountId is not an account of this group');
      const mapping = await setCoaMapping(groupId, companyId, companyAccountId, groupAccountId);
      return apiResponse.success(res, mapping);
    }

    if (action === 'auto-map') {
      const { groupId, companyId } = req.body;
      if (!groupId || !companyId) return apiResponse.badRequest(res, 'groupId and companyId required');
      const refused = await refuseGroupWrite(groupId);
      if (refused) return apiResponse.forbidden(res, refused);
      const refusedCompany = await refuseGroupCompanyWrite(userId, groupId, companyId);
      if (refusedCompany) return refuse(refusedCompany);
      const count = await autoMapAccounts(groupId, companyId);
      return apiResponse.success(res, { mappedCount: count });
    }

    // No action: create group. (An unknown action never reaches here — groupRequestError refuses
    // it; the COA tab's old 'add-account' used to fall through and create a GROUP.)
    const { name, holdingCompanyId, defaultCurrency, financialYearStart } = req.body;
    if (!name) return apiResponse.badRequest(res, 'name is required');
    // createGroup auto-enrolls holdingCompanyId as a group member, so it is the same
    // cross-tenant injection vector as add-member — gate it on caller membership (H1).
    if (holdingCompanyId && !(await userCanWriteCompany(userId, holdingCompanyId))) {
      return apiResponse.forbidden(res, COMPANY_WRITE_REFUSED);
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
      const refused = await refuseGroupWrite(memberGroupId);
      if (refused) return apiResponse.forbidden(res, refused);
      await updateMember(memberId, { ownershipPct, consolidationMethod }, memberGroupId);
      return apiResponse.success(res, { updated: true });
    }

    if (action === 'update-group-account') {
      const { accountId, groupId: accountGroupId, ...updates } = req.body;
      if (!accountId) return apiResponse.badRequest(res, 'accountId required');
      if (!accountGroupId) return apiResponse.badRequest(res, 'groupId required');
      const refused = await refuseGroupWrite(accountGroupId);
      if (refused) return apiResponse.forbidden(res, refused);
      const account = await updateGroupAccount(accountId, updates, accountGroupId);
      return apiResponse.success(res, account);
    }

    const { groupId, ...updates } = req.body;
    if (!groupId) return apiResponse.badRequest(res, 'groupId required');
    const refused = await refuseGroupWrite(groupId);
    if (refused) return apiResponse.forbidden(res, refused);
    // Same cross-tenant injection vector the create branch guards (pentest H1):
    // holdingCompanyId arrives in the body. This path was unreachable while the
    // UI sent `id` instead of `groupId`, so fixing that casing would otherwise
    // have activated an ungated body-supplied companyId.
    if (updates.holdingCompanyId && !(await userCanWriteCompany(userId, updates.holdingCompanyId))) {
      return apiResponse.forbidden(res, COMPANY_WRITE_REFUSED);
    }
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
      const refused = await refuseGroupWrite(groupId);
      if (refused) return apiResponse.forbidden(res, refused);
      await removeMember(memberId, groupId);
      return apiResponse.success(res, { removed: true });
    }

    if (action === 'remove-mapping') {
      const mappingId = req.query.mapping_id as string;
      const groupId = req.query.group_id as string;
      if (!mappingId) return apiResponse.badRequest(res, 'mapping_id required');
      if (!groupId) return apiResponse.badRequest(res, 'group_id required');
      const refused = await refuseGroupWrite(groupId);
      if (refused) return apiResponse.forbidden(res, refused);
      // Removing a company's mapping changes its consolidated figures: a write role in it, as set-mapping.
      const mappedCompany = await mappingCompanyId(mappingId, groupId);
      if (!mappedCompany) return apiResponse.notFound(res, 'Mapping');
      if (!(await userCanWriteCompany(userId, mappedCompany))) return apiResponse.forbidden(res, COMPANY_CHART_REFUSED);
      await removeCoaMapping(mappingId, groupId);
      return apiResponse.success(res, { removed: true });
    }

    if (action === 'delete-group-account') {
      const accountId = req.query.account_id as string;
      const groupId = req.query.group_id as string;
      if (!accountId) return apiResponse.badRequest(res, 'account_id required');
      if (!groupId) return apiResponse.badRequest(res, 'group_id required');
      const refused = await refuseGroupWrite(groupId);
      if (refused) return apiResponse.forbidden(res, refused);
      await deleteGroupAccount(accountId, groupId);
      return apiResponse.success(res, { deleted: true });
    }

    const groupId = req.query.group_id as string;
    if (!groupId) return apiResponse.badRequest(res, 'group_id required');
    const refused = await refuseGroupWrite(groupId);
    if (refused) return apiResponse.forbidden(res, refused);
    await deleteGroup(groupId);
    return apiResponse.success(res, { deleted: true });
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST', 'PUT', 'DELETE']);
}

 
export default withAuth(withErrorHandler(withCsrf(handler)));
