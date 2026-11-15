/**
 * Admin Announcement Detail API
 * GET    /api/admin/announcements/[id]
 * PATCH  /api/admin/announcements/[id]
 * DELETE /api/admin/announcements/[id]
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import {
  getAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
} from '@/modules/admin/services/announcementService';
import { logAdminAction } from '@/modules/admin/services/auditService';
import {
  announcementInstant, announcementWindowError, AnnouncementTarget, AnnouncementTargetIds, AnnouncementType,
  WINDOW_ORDER_ERROR, ANNOUNCEMENT_TITLE_MAX, ANNOUNCEMENT_MESSAGE_MAX, firstValidationMessage,
} from '@/modules/admin/services/announcementWindow';
import { isUuidParam } from '@/lib/validation';
import { getIp } from '@/utils/getIp';

const PatchBody = z.object({
  title:          z.string().min(1).max(ANNOUNCEMENT_TITLE_MAX, `Title must be at most ${ANNOUNCEMENT_TITLE_MAX} characters`).optional(),
  message:        z.string().min(1).max(ANNOUNCEMENT_MESSAGE_MAX, `Message must be at most ${ANNOUNCEMENT_MESSAGE_MAX} characters`).optional(),
  type:           AnnouncementType.optional(),
  target:         AnnouncementTarget.optional(),
  target_ids:     AnnouncementTargetIds.optional(),
  starts_at:      announcementInstant('Start').optional(),
  /** null clears the end (no end); omitted keeps it. */
  ends_at:        announcementInstant('End').nullable().optional(),
  is_dismissible: z.boolean().optional(),
}).strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const id = req.query.id;
  if (!isUuidParam(id)) return apiResponse.notFound(res, 'Announcement');

  if (req.method === 'GET') {
    const item = await getAnnouncement(id);
    if (!item) return apiResponse.notFound(res, 'Announcement', id);
    return apiResponse.success(res, item);
  }

  if (req.method === 'PATCH') {
    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) {
      return apiResponse.badRequest(res, firstValidationMessage(parsed.error));
    }

    // The window is judged on what will be stored: the body's value, else the stored one, for each side.
    const current = await getAnnouncement(id);
    if (!current) return apiResponse.notFound(res, 'Announcement', id);
    const windowError = announcementWindowError(
      parsed.data.starts_at ?? current.starts_at,
      parsed.data.ends_at === undefined ? current.ends_at : parsed.data.ends_at,
    );
    if (windowError) return apiResponse.badRequest(res, windowError);

    const outcome = await updateAnnouncement(id, parsed.data);
    if (outcome === 'not_found') return apiResponse.notFound(res, 'Announcement', id);
    // The pre-check above gives the friendly text; this is the write-time guard it cannot replace.
    if (outcome === 'window') return apiResponse.badRequest(res, WINDOW_ORDER_ERROR);

    await logAdminAction(
      req.user.id,
      'announcement.update',
      'announcement',
      id,
      parsed.data as Record<string, unknown>,
      getIp(req)
    );

    return apiResponse.success(res, { updated: true });
  }

  if (req.method === 'DELETE') {
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
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'PATCH', 'DELETE']);
}

export default withAdmin(withCsrf(handler));
