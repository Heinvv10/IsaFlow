/**
 * Admin Announcements API
 * GET  /api/admin/announcements — list all (optional ?active_only=true)
 * POST /api/admin/announcements — create announcement
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { adminPaging } from '@/modules/admin/middleware/adminRequestErrors';
import { apiResponse } from '@/lib/apiResponse';
import {
  listAnnouncements,
  createAnnouncement,
} from '@/modules/admin/services/announcementService';
import { logAdminAction } from '@/modules/admin/services/auditService';
import {
  announcementInstant, announcementWindowError, AnnouncementTarget, AnnouncementTargetIds, AnnouncementType,
  ANNOUNCEMENT_TITLE_MAX, ANNOUNCEMENT_MESSAGE_MAX, firstValidationMessage,
} from '@/modules/admin/services/announcementWindow';
import { getIp } from '@/utils/getIp';

const PostBody = z.object({
  title:          z.string().min(1).max(ANNOUNCEMENT_TITLE_MAX, `Title must be at most ${ANNOUNCEMENT_TITLE_MAX} characters`),
  message:        z.string().min(1).max(ANNOUNCEMENT_MESSAGE_MAX, `Message must be at most ${ANNOUNCEMENT_MESSAGE_MAX} characters`),
  type:           AnnouncementType.optional(),
  target:         AnnouncementTarget.optional(),
  target_ids:     AnnouncementTargetIds.optional(),
  starts_at:      announcementInstant('Start'),
  ends_at:        announcementInstant('End').optional(),
  is_dismissible: z.boolean().optional(),
}).strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    const { active_only, page, limit } = req.query;
    const result = await listAnnouncements({
      active_only: active_only === 'true',
      ...adminPaging({ page, limit }),
    });
    return apiResponse.success(res, result);
  }

  if (req.method === 'POST') {
    const parsed = PostBody.safeParse(req.body);
    if (!parsed.success) {
      return apiResponse.badRequest(res, firstValidationMessage(parsed.error));
    }

    const windowError = announcementWindowError(parsed.data.starts_at, parsed.data.ends_at);
    if (windowError) return apiResponse.badRequest(res, windowError);

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
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAdmin(withCsrf(handler));
