/**
 * Comments on invoices, bills and bank lines (master plan wave 5, M14). Plain text, in-app mentions only.
 *
 * GET    ?recordType=&recordId=   the record's comments (oldest first) and the colleagues one can mention. Any role.
 * POST   { recordType, recordId, body, mentions? }   add a comment. Owner, admin or manager (write roles).
 * PUT    ?id=  { body, mentions? }                    edit your own comment.
 * DELETE ?id=                                         delete your own comment (soft).
 *
 * A record of another company is 404 before anything is written; someone else's comment is 403; a Login-as
 * session is refused (403 IMPERSONATION_FORBIDDEN); writes are limited per company and user.
 */
import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { canWrite } from '@/lib/auth/writeRoles';
import { withCsrf } from '@/lib/auth/withCsrf';
import { respondIfImpersonationForbidden } from '@/lib/auth/impersonationGuard';
import { checkRateLimit } from '@/lib/rateLimit';
import { UUID } from '@/lib/schemas/common';
import { log } from '@/lib/logger';
import { COMMENT_RECORD_TYPES } from '@/modules/accounting/services/comments/commentRecords';
import { CommentError, MAX_COMMENT_BODY, MAX_MENTIONS } from '@/modules/accounting/services/comments/commentText';
import { createComment, deleteComment, editComment, listComments } from '@/modules/accounting/services/comments/recordCommentService';

const Mentions = z.array(z.string().min(1).max(255)).max(MAX_MENTIONS).optional();
const Body = z.string().max(MAX_COMMENT_BODY * 4);
const Create = z.object({ recordType: z.enum(COMMENT_RECORD_TYPES), recordId: UUID, body: Body, mentions: Mentions }).strict();
const Edit = z.object({ body: Body, mentions: Mentions }).strict();
/** The specific sentence, not zod's generic 422, for a comment naming too many people. */
const tooManyMentions = (body: unknown): boolean =>
  Array.isArray((body as { mentions?: unknown } | null)?.mentions) && (body as { mentions: unknown[] }).mentions.length > MAX_MENTIONS;
const TOO_MANY = `A comment mentions at most ${MAX_MENTIONS} people`;
const ListQuery = z.object({ recordType: z.enum(COMMENT_RECORD_TYPES), recordId: UUID });

const MENTION_LIMIT_MESSAGE = 'You have mentioned a lot of people this hour. Try again later.';

/** Mentions are notifications, so they are budgeted per sender too: a comment can name up to MAX_MENTIONS people. */
async function mentionBudget(companyId: string, userId: string, mentions: readonly string[] | undefined): Promise<boolean> {
  if (!mentions || mentions.length === 0) return true;
  return checkRateLimit(`comments:mentions:${companyId}:${userId}`, { max: 100, windowSecs: 3600, cost: mentions.length });
}

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  const { companyId } = req;
  const userId = req.user.id;
  try {
    if (req.method === 'GET') {
      const q = ListQuery.safeParse(req.query);
      if (!q.success) return apiResponse.zodValidationError(res, q.error);
      return apiResponse.success(res, await listComments(companyId, userId, q.data.recordType, q.data.recordId, canWrite(req.companyRole)));
    }
    if (req.method !== 'POST' && req.method !== 'PUT' && req.method !== 'DELETE') {
      return apiResponse.methodNotAllowed(res, req.method ?? 'unknown', ['GET', 'POST', 'PUT', 'DELETE']);
    }
    // Per company and user per minute: far above typing speed, far below a script.
    if (!(await checkRateLimit(`comments:write:${companyId}:${userId}`, { max: 30, windowSecs: 60 }))) {
      log.warn('Comment write rate limit exceeded', { companyId }, 'record-comments');
      return apiResponse.tooManyRequests(res, 'You are commenting too fast. Wait a minute and try again.');
    }
    if (req.method === 'POST') {
      if (tooManyMentions(req.body)) return apiResponse.badRequest(res, TOO_MANY);
      const b = Create.safeParse(req.body);
      if (!b.success) return apiResponse.zodValidationError(res, b.error);
      if (!(await mentionBudget(companyId, userId, b.data.mentions))) return apiResponse.tooManyRequests(res, MENTION_LIMIT_MESSAGE);
      return apiResponse.created(res, await createComment(companyId, userId, b.data.recordType, b.data.recordId, b.data.body, b.data.mentions));
    }
    const id = UUID.safeParse(req.query.id);
    if (!id.success) return apiResponse.badRequest(res, 'id is required');
    if (req.method === 'PUT') {
      if (tooManyMentions(req.body)) return apiResponse.badRequest(res, TOO_MANY);
      const b = Edit.safeParse(req.body);
      if (!b.success) return apiResponse.zodValidationError(res, b.error);
      if (!(await mentionBudget(companyId, userId, b.data.mentions))) return apiResponse.tooManyRequests(res, MENTION_LIMIT_MESSAGE);
      return apiResponse.success(res, await editComment(companyId, userId, id.data, b.data.body, b.data.mentions));
    }
    await deleteComment(companyId, userId, id.data);
    return apiResponse.success(res, { id: id.data });
  } catch (err) {
    if (respondIfImpersonationForbidden(res, err)) return undefined;
    if (err instanceof CommentError) {
      if (err.status === 404) return apiResponse.notFound(res, err.message);
      if (err.status === 403) return apiResponse.forbidden(res, err.message);
      return apiResponse.badRequest(res, err.message);
    }
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
