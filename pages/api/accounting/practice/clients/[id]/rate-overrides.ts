/**
 * Practice Client Rate Overrides API
 * GET    /api/accounting/practice/clients/[id]/rate-overrides        – list
 * POST   /api/accounting/practice/clients/[id]/rate-overrides        – create
 * PUT    /api/accounting/practice/clients/[id]/rate-overrides?overrideId=xxx – update
 * DELETE /api/accounting/practice/clients/[id]/rate-overrides?overrideId=xxx – delete
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withWriteAccess } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import {
  listClientRateOverrides,
  createClientRateOverride,
  updateClientRateOverride,
  deleteClientRateOverride,
  type CreateRateOverrideInput,
  type UpdateRateOverrideInput,
} from '@/modules/accounting/services/practice/practiceClientRateOverrideService';
import {
  assertPracticeClientInCompany,
  PracticeClientNotInCompanyError,
} from '@/modules/accounting/services/practice/practiceClientFence';
import { isUuidParam } from '@/lib/validation';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  const clientId = req.query.id as string;

  if (!clientId) return apiResponse.badRequest(res, 'Client ID required');
  // R-163: a malformed id is a 400; the fence would fold it into "not found".
  if (!isUuidParam(clientId)) return apiResponse.badRequest(res, 'Invalid client ID');

  try {
    await assertPracticeClientInCompany(companyId, clientId);
  } catch (err) {
    if (err instanceof PracticeClientNotInCompanyError) return apiResponse.notFound(res, 'Client');
    throw err;
  }

  if (req.method === 'GET') {
    const overrides = await listClientRateOverrides(companyId, clientId);
    return apiResponse.success(res, overrides);
  }

  if (req.method === 'POST') {
    const body = req.body as Partial<CreateRateOverrideInput>;

    if (!body.staffUserId) return apiResponse.badRequest(res, 'staffUserId is required');
    if (body.ratePerHour === undefined || body.ratePerHour === null) {
      return apiResponse.badRequest(res, 'ratePerHour is required');
    }
    if (Number(body.ratePerHour) < 0) {
      return apiResponse.badRequest(res, 'ratePerHour must be >= 0');
    }
    if (!body.effectiveFrom) return apiResponse.badRequest(res, 'effectiveFrom is required');

    const input: CreateRateOverrideInput = {
      staffUserId: body.staffUserId,
      ratePerHour: Number(body.ratePerHour),
      effectiveFrom: body.effectiveFrom,
      effectiveTo: body.effectiveTo ?? null,
      notes: body.notes ?? null,
    };

    const created = await createClientRateOverride(companyId, clientId, input);
    return apiResponse.created(res, created);
  }

  if (req.method === 'PUT') {
    const overrideId = req.query.overrideId as string | undefined;
    if (!overrideId) return apiResponse.badRequest(res, 'overrideId query param required');

    const body = req.body as Partial<UpdateRateOverrideInput>;

    if (body.ratePerHour !== undefined && Number(body.ratePerHour) < 0) {
      return apiResponse.badRequest(res, 'ratePerHour must be >= 0');
    }

    const input: UpdateRateOverrideInput = {
      ...(body.ratePerHour !== undefined && { ratePerHour: Number(body.ratePerHour) }),
      ...(body.effectiveFrom !== undefined && { effectiveFrom: body.effectiveFrom }),
      ...(body.effectiveTo !== undefined && { effectiveTo: body.effectiveTo }),
      ...(body.notes !== undefined && { notes: body.notes }),
    };

    const updated = await updateClientRateOverride(companyId, clientId, overrideId, input);
    if (!updated) return apiResponse.notFound(res, 'Rate override');
    return apiResponse.success(res, updated);
  }

  if (req.method === 'DELETE') {
    const overrideId = req.query.overrideId as string | undefined;
    if (!overrideId) return apiResponse.badRequest(res, 'overrideId query param required');

    const deleted = await deleteClientRateOverride(companyId, clientId, overrideId);
    if (!deleted) return apiResponse.notFound(res, 'Rate override');
    return apiResponse.success(res, { ok: true });
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST', 'PUT', 'DELETE']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
