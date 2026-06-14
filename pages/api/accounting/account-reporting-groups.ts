/**
 * Account Reporting Groups API
 * GET    — list all active groups with members
 * POST   — create a new group
 * PATCH  ?id= — update name / order / report_type
 * DELETE ?id= — soft-delete (is_active = false)
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import {
  listAccountReportingGroups,
  createAccountReportingGroup,
  updateAccountReportingGroup,
  softDeleteAccountReportingGroup,
} from '@/modules/accounting/services/reports/accountReportingGroupsService';

const VALID_REPORT_TYPES = ['balance_sheet', 'income_statement', 'both'] as const;
type ReportType = typeof VALID_REPORT_TYPES[number];

function isValidReportType(v: unknown): v is ReportType {
  return VALID_REPORT_TYPES.includes(v as ReportType);
}

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  const { companyId } = req;

  // ── GET ──────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const groups = await listAccountReportingGroups(companyId);
    return apiResponse.success(res, { items: groups, count: groups.length });
  }

  // ── POST ─────────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const { name, report_type, display_order } = req.body as Record<string, unknown>;

    if (!name || typeof name !== 'string' || !name.trim()) {
      return apiResponse.badRequest(res, 'name is required');
    }
    if (!isValidReportType(report_type)) {
      return apiResponse.badRequest(res, `report_type must be one of: ${VALID_REPORT_TYPES.join(', ')}`);
    }

    try {
      const group = await createAccountReportingGroup(companyId, {
        name: name.trim(),
        report_type,
        display_order: typeof display_order === 'number' ? display_order : 0,
      });
      return apiResponse.success(res, group, 'Group created', 201);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : '';
      if (errMsg.includes('unique') || errMsg.includes('duplicate')) {
        return apiResponse.badRequest(res, 'A group with that name already exists');
      }
      log.error('Failed to create account reporting group', { error: err, companyId }, 'accounting-api');
      return apiResponse.badRequestFromError(res, err, 'Failed to create group');
    }
  }

  // ── PATCH ─────────────────────────────────────────────────────────────────
  if (req.method === 'PATCH') {
    const id = req.query.id as string | undefined;
    if (!id) return apiResponse.badRequest(res, 'id query parameter is required');

    const { name, report_type, display_order } = req.body as Record<string, unknown>;

    if (report_type !== undefined && !isValidReportType(report_type)) {
      return apiResponse.badRequest(res, `report_type must be one of: ${VALID_REPORT_TYPES.join(', ')}`);
    }

    const updated = await updateAccountReportingGroup(companyId, id, {
      name: typeof name === 'string' ? name.trim() : undefined,
      report_type: isValidReportType(report_type) ? report_type : undefined,
      display_order: typeof display_order === 'number' ? display_order : undefined,
    });

    if (!updated) return apiResponse.notFound(res, 'Group not found');
    return apiResponse.success(res, updated);
  }

  // ── DELETE ────────────────────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    const id = req.query.id as string | undefined;
    if (!id) return apiResponse.badRequest(res, 'id query parameter is required');

    const deleted = await softDeleteAccountReportingGroup(companyId, id);
    if (!deleted) return apiResponse.notFound(res, 'Group not found');
    return apiResponse.success(res, { id }, 'Group deleted');
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST', 'PATCH', 'DELETE']);
}

export default withAuth(withErrorHandler(withCsrf(handler)));
