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
import { sql } from '@/lib/neon';
import {
  listGroups,
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
} from '@/modules/accounting/services/groupCompanyService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  const action = (req.query.action || req.body?.action) as string | undefined;

  // ── GET ────────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const groupId = req.query.group_id as string | undefined;

    if (action === 'members' && groupId) {
      const members = await getGroupMembers(groupId);
      return apiResponse.success(res, { items: members });
    }

    if (action === 'accounts' && groupId) {
      const accounts = await getGroupAccounts(groupId);
      return apiResponse.success(res, { items: accounts });
    }

    if (action === 'mappings' && groupId) {
      const companyId = req.query.company_id as string | undefined;
      if (companyId) {
        const membership = await sql`SELECT 1 FROM company_users WHERE company_id = ${companyId}::UUID AND user_id = ${userId}::UUID LIMIT 1` as Record<string, unknown>[];
        if (!membership[0]) return apiResponse.forbidden(res, 'Access denied to the specified company');
      }
      const mappings = await getCoaMappings(groupId, companyId);
      return apiResponse.success(res, { items: mappings });
    }

    if (action === 'unmapped' && groupId) {
      const companyId = req.query.company_id as string;
      if (!companyId) return apiResponse.badRequest(res, 'company_id required');
      const membership = await sql`SELECT 1 FROM company_users WHERE company_id = ${companyId}::UUID AND user_id = ${userId}::UUID LIMIT 1` as Record<string, unknown>[];
      if (!membership[0]) return apiResponse.forbidden(res, 'Access denied to the specified company');
      const unmapped = await getUnmappedAccounts(groupId, companyId);
      return apiResponse.success(res, { items: unmapped });
    }

    if (groupId) {
      const group = await getGroup(groupId);
      if (!group) return apiResponse.notFound(res, 'Group');
      return apiResponse.success(res, group);
    }

    const groups = await listGroups();
    return apiResponse.success(res, { items: groups });
  }

  // ── POST ───────────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    if (action === 'add-member') {
      const { groupId, companyId, ownershipPct, consolidationMethod } = req.body;
      if (!groupId || !companyId) return apiResponse.badRequest(res, 'groupId and companyId required');
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
      const account = await createGroupAccount(groupId, {
        accountCode, accountName, accountType, accountSubtype, parentAccountId, normalBalance, level, displayOrder,
      });
      return apiResponse.success(res, account);
    }

    if (action === 'auto-generate-coa') {
      const { groupId, sourceCompanyId } = req.body;
      if (!groupId || !sourceCompanyId) return apiResponse.badRequest(res, 'groupId and sourceCompanyId required');
      const count = await autoGenerateGroupCOA(groupId, sourceCompanyId);
      return apiResponse.success(res, { accountsCreated: count });
    }

    if (action === 'set-mapping') {
      const { groupId, companyId, companyAccountId, groupAccountId } = req.body;
      if (!groupId || !companyId || !companyAccountId || !groupAccountId) {
        return apiResponse.badRequest(res, 'groupId, companyId, companyAccountId, groupAccountId required');
      }
      const mapping = await setCoaMapping(groupId, companyId, companyAccountId, groupAccountId);
      return apiResponse.success(res, mapping);
    }

    if (action === 'auto-map') {
      const { groupId, companyId } = req.body;
      if (!groupId || !companyId) return apiResponse.badRequest(res, 'groupId and companyId required');
      const count = await autoMapAccounts(groupId, companyId);
      return apiResponse.success(res, { mappedCount: count });
    }

    // Default POST: create group
    const { name, holdingCompanyId, defaultCurrency, financialYearStart } = req.body;
    if (!name) return apiResponse.badRequest(res, 'name is required');
    const group = await createGroup({ name, holdingCompanyId, defaultCurrency, financialYearStart }, userId);
    return apiResponse.success(res, group);
  }

  // ── PUT ────────────────────────────────────────────────────────────────────
  if (req.method === 'PUT') {
    if (action === 'update-member') {
      const { memberId, ownershipPct, consolidationMethod } = req.body;
      if (!memberId) return apiResponse.badRequest(res, 'memberId required');
      await updateMember(memberId, { ownershipPct, consolidationMethod });
      return apiResponse.success(res, { updated: true });
    }

    if (action === 'update-group-account') {
      const { accountId, ...updates } = req.body;
      if (!accountId) return apiResponse.badRequest(res, 'accountId required');
      const account = await updateGroupAccount(accountId, updates);
      return apiResponse.success(res, account);
    }

    const { groupId, ...updates } = req.body;
    if (!groupId) return apiResponse.badRequest(res, 'groupId required');
    const group = await updateGroup(groupId, updates);
    return apiResponse.success(res, group);
  }

  // ── DELETE ─────────────────────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    if (action === 'remove-member') {
      const memberId = req.query.member_id as string;
      if (!memberId) return apiResponse.badRequest(res, 'member_id required');
      await removeMember(memberId);
      return apiResponse.success(res, { removed: true });
    }

    if (action === 'remove-mapping') {
      const mappingId = req.query.mapping_id as string;
      if (!mappingId) return apiResponse.badRequest(res, 'mapping_id required');
      await removeCoaMapping(mappingId);
      return apiResponse.success(res, { removed: true });
    }

    if (action === 'delete-group-account') {
      const accountId = req.query.account_id as string;
      if (!accountId) return apiResponse.badRequest(res, 'account_id required');
      await deleteGroupAccount(accountId);
      return apiResponse.success(res, { deleted: true });
    }

    const groupId = req.query.group_id as string;
    if (!groupId) return apiResponse.badRequest(res, 'group_id required');
    await deleteGroup(groupId);
    return apiResponse.success(res, { deleted: true });
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST', 'PUT', 'DELETE']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withAuth(withErrorHandler(handler));
