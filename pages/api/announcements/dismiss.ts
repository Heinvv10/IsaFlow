/**
 * Dismiss an announcement — Customer-facing
 * POST /api/announcements/dismiss  { id }
 * Only an announcement that targets the caller's company can be dismissed (404 otherwise).
 * Remembers, for the calling user only, that they closed this announcement (a user_preferences row), so
 * GET /api/announcements/active stops returning it to them. Refused for an announcement the admin marked
 * not dismissible. A Login-as session leaves no trace: it would be written under the target user's name.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { assertNotImpersonating, respondIfImpersonationForbidden } from '@/lib/auth/impersonationGuard';
import { sql } from '@/lib/neon';
import { isUuidParam } from '@/lib/validation';
import { announcementTargetsCompany } from '@/lib/tenantAnnouncementsSql';
import { DISMISS_KEY_PREFIX } from '@/lib/tenantAnnouncements';

const Body = z.object({ id: z.string() }).strict();

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }
  const parsed = Body.safeParse(req.body);
  if (!parsed.success || !isUuidParam(parsed.data.id)) {
    return apiResponse.badRequest(res, 'A valid announcement id is required');
  }
  const { id } = parsed.data;

  try {
    await assertNotImpersonating();
  } catch (err) {
    if (respondIfImpersonationForbidden(res, err)) return;
    throw err;
  }

  const { companyId, user } = req as CompanyAuthedRequest;
  const [found] = await sql`
    SELECT a.is_dismissible FROM system_announcements a
    WHERE a.id = ${id} AND ${announcementTargetsCompany(companyId)}`;
  if (!found) return apiResponse.notFound(res, 'Announcement', id);
  if (!found.is_dismissible) return apiResponse.badRequest(res, 'This announcement cannot be dismissed');

  await sql`
    INSERT INTO user_preferences (user_id, key, value, updated_at)
    VALUES (${user.id}, ${DISMISS_KEY_PREFIX + id}, 'true', NOW())
    ON CONFLICT (user_id, key) DO UPDATE SET value = 'true', updated_at = NOW()
  `;
  return apiResponse.success(res, { id });
}

export default withAuth(withErrorHandler(withCsrf(handler)));
