/**
 * Admin Announcements API
 * GET  /api/admin/announcements — list all (optional ?active_only=true)
 * POST /api/admin/announcements — create announcement
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import {
  listAnnouncements,
  createAnnouncement,
} from '@/modules/admin/services/announcementService';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';

const PostBody = z.object({
  title:          z.string().min(1),
  message:        z.string().min(1),
  type:           z.string().optional(),
  target:         z.string().optional(),
  target_ids:     z.array(z.string()).optional(),
  starts_at:      z.string().min(1),
  ends_at:        z.string().optional(),
  is_dismissible: z.boolean().optional(),
}).strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    try {
      const { active_only, page, limit } = req.query;
      const result = await listAnnouncements({
        active_only: active_only === 'true',
        page:  page  ? Number(page)  : undefined,
        limit: limit ? Number(limit) : undefined,
      });
      return apiResponse.success(res, result);
    } catch (err) {
      log.error('Failed to list announcements', { error: err }, 'admin-api');
      return apiResponse.badRequest(res, 'Failed to list announcements');
    }
  }

  if (req.method === 'POST') {
    const parsed = PostBody.safeParse(req.body);
    if (!parsed.success) {
      return apiResponse.badRequest(res, parsed.error.flatten().formErrors[0] ?? 'Invalid input');
    }

    try {
      const { title, message, type, target, target_ids, starts_at, ends_at, is_dismissible } = parsed.data;

      const id = await createAnnouncement({
        title,
        message,
        type,
        target,
        target_ids,
        starts_at,
        ends_at,
        is_dismissible,
        created_by: req.user.id,
      });

      await logAdminAction(
        req.user.id,
        'announcement.create',
        'announcement',
        id,
        { title: String(title) },
        getIp(req)
      );

      return apiResponse.success(res, { id });
    } catch (err) {
      log.error('Failed to create announcement', { error: err }, 'admin-api');
      return apiResponse.badRequest(res, 'Failed to create announcement');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAdmin(handler);
