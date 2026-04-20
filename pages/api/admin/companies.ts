/**
 * Admin Companies List API
 * GET  /api/admin/companies — List all companies across the platform
 * POST /api/admin/companies — Create a new company
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { listCompanies, createCompany } from '@/modules/admin/services/adminCompanyService';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';

const PostBody = z.object({
  name:         z.string().min(1).max(200),
  trading_name: z.string().max(200).optional().nullable(),
  email:        z.string().email().max(200).optional().nullable().or(z.literal('')),
  phone:        z.string().max(50).optional().nullable().or(z.literal('')),
  plan_id:      z.string().uuid().optional().nullable().or(z.literal('')),
}).strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    try {
      const {
        search,
        status,
        plan,
        page,
        limit,
        sort_by,
        sort_dir,
      } = req.query;

      const result = await listCompanies({
        search: search as string | undefined,
        status: status as string | undefined,
        plan: plan as string | undefined,
        page: page ? Number(page) : undefined,
        limit: limit ? Number(limit) : undefined,
        sort_by: sort_by as string | undefined,
        sort_dir: sort_dir as 'asc' | 'desc' | undefined,
      });

      return apiResponse.success(res, result);
    } catch (err) {
      log.error('Failed to list companies', { error: err }, 'admin-api');
      return apiResponse.badRequest(res, 'Failed to list companies');
    }
  }

  if (req.method === 'POST') {
    const parsed = PostBody.safeParse(req.body);
    if (!parsed.success) {
      return apiResponse.badRequest(res, parsed.error.flatten().formErrors[0] ?? 'Invalid input');
    }

    try {
      const { name, trading_name, email, phone, plan_id } = parsed.data;
      const created = await createCompany({
        name,
        trading_name: trading_name || null,
        email:        email || null,
        phone:        phone || null,
        plan_id:      plan_id || null,
      });

      await logAdminAction(
        req.user.id,
        'company.create',
        'company',
        created.id,
        { name: created.name, plan_id: plan_id || null },
        getIp(req)
      );

      return apiResponse.success(res, created);
    } catch (err) {
      log.error('Failed to create company', { error: err }, 'admin-api');
      return apiResponse.badRequest(res, 'Failed to create company');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
}

export default withAdmin(handler);
