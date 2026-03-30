/**
 * Admin Announcements API
 * GET  /api/admin/announcements — list all (optional ?active_only=true)
 * POST /api/admin/announcements — create announcement
 */

import type { NextApiResponse } from 'next';
import { withAuth, withRole, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import {
  listAnnouncements,
  createAnnouncement,
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
    try {
      const { title, message, type, target, target_ids, starts_at, ends_at, is_dismissible } =
        req.body as Record<string, unknown>;

      if (!title || !message || !starts_at) {
        return apiResponse.badRequest(res, 'title, message, and starts_at are required');
      }

      const id = await createAnnouncement({
        title:          String(title),
        message:        String(message),
        type:           type          ? String(type)    : undefined,
        target:         target        ? String(target)  : undefined,
        target_ids:     Array.isArray(target_ids) ? (target_ids as string[]) : undefined,
        starts_at:      String(starts_at),
        ends_at:        ends_at       ? String(ends_at) : undefined,
        is_dismissible: typeof is_dismissible === 'boolean' ? is_dismissible : undefined,
        created_by:     req.user.id,
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withAuth(withRole('super_admin')(withErrorHandler(handler as any) as any) as any);
