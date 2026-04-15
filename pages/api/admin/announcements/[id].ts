/**
 * Admin Announcement Detail API
 * GET    /api/admin/announcements/[id]
 * PATCH  /api/admin/announcements/[id]
 * DELETE /api/admin/announcements/[id]
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import {
  getAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
} from '@/modules/admin/services/announcementService';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';

const PatchBody = z.object({
  title:          z.string().min(1).optional(),
  message:        z.string().min(1).optional(),
  type:           z.string().optional(),
  target:         z.string().optional(),
  target_ids:     z.array(z.string()).optional(),
  starts_at:      z.string().optional(),
  ends_at:        z.string().optional(),
  is_dismissible: z.boolean().optional(),
}).strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const id = req.query.id as string;

  if (req.method === 'GET') {
    try {
      const item = await getAnnouncement(id);
      if (!item) return apiResponse.notFound(res, 'Announcement', id);
      return apiResponse.success(res, item);
    } catch (err) {
      log.error('Failed to get announcement', { id, error: err }, 'admin-api');
      return apiResponse.badRequest(res, 'Failed to get announcement');
    }
  }

  if (req.method === 'PATCH') {
    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) {
      return apiResponse.badRequest(res, parsed.error.flatten().formErrors[0] ?? 'Invalid input');
    }

    try {
      await updateAnnouncement(id, parsed.data);

      await logAdminAction(
        req.user.id,
        'announcement.update',
        'announcement',
        id,
        parsed.data as Record<string, unknown>,
        getIp(req)
      );

      return apiResponse.success(res, { updated: true });
    } catch (err) {
      log.error('Failed to update announcement', { id, error: err }, 'admin-api');
      return apiResponse.badRequest(res, 'Failed to update announcement');
    }
  }

  if (req.method === 'DELETE') {
    try {
      await deleteAnnouncement(id);

      await logAdminAction(
        req.user.id,
        'announcement.delete',
        'announcement',
        id,
        null,
        getIp(req)
      );

      return apiResponse.success(res, { deleted: true });
    } catch (err) {
      log.error('Failed to delete announcement', { id, error: err }, 'admin-api');
      return apiResponse.badRequest(res, 'Failed to delete announcement');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'PATCH', 'DELETE']);
}

export default withAdmin(handler);
