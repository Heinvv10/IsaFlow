/**
 * Admin Announcement Detail API
 * GET    /api/admin/announcements/[id]
 * PATCH  /api/admin/announcements/[id]
 * DELETE /api/admin/announcements/[id]
 */

import type { NextApiResponse } from 'next';
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

function getIp(req: AuthenticatedNextApiRequest): string | null {
  return (
    (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    null
  );
}

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
    try {
      const body = req.body as Record<string, unknown>;
      await updateAnnouncement(id, {
        title:          body.title          ? String(body.title)          : undefined,
        message:        body.message        ? String(body.message)        : undefined,
        type:           body.type           ? String(body.type)           : undefined,
        target:         body.target         ? String(body.target)         : undefined,
        target_ids:     Array.isArray(body.target_ids) ? (body.target_ids as string[]) : undefined,
        starts_at:      body.starts_at      ? String(body.starts_at)      : undefined,
        ends_at:        body.ends_at        ? String(body.ends_at)        : undefined,
        is_dismissible: typeof body.is_dismissible === 'boolean' ? body.is_dismissible : undefined,
      });

      await logAdminAction(
        req.user.id,
        'announcement.update',
        'announcement',
        id,
        body as Record<string, unknown>,
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
