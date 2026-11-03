/**
 * Budget variance notes (budgets P5 spec §3e, §4). Company from the session; the roles are the service's
 * (`commentary/varianceCommentary.ts`), checked before anything is read.
 *
 * GET  ?versionId=&month=YYYY-MM → { notes } — every member: approved notes; owner/admin/manager also
 *      see drafts and rejected notes (labelled by `status`).
 * POST { action: 'save', versionId, month, glAccountId, cc1Id, cc2Id, buId, text } → { note } — owner/admin/manager:
 *      the slice's draft (an approved note: owner/admin only, withdrawing the approval).
 * POST { action: 'approve', id, text? } → { note } — owner/admin; `text` approves the approver's own wording.
 * POST { action: 'reject', id } → { note } — owner/admin.
 *
 * Every id is the company's or the answer is 404 (another tenant's id reads as missing). 403 for a role,
 * 422 for a malformed body or query (zod), 400 for the text or a month outside the version's year, 409 for
 * an approved note a manager may not change or a state race. 60 writes and 240 reads a minute per user (429).
 */
import { z } from 'zod';
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import { checkRateLimit } from '@/lib/rateLimit';
import {
  approveVarianceNote, listVarianceNotes, rejectVarianceNote, saveVarianceNote, type VarianceFailureCode,
} from '@/modules/accounting/services/commentary/varianceCommentary';

const Text = z.string().max(20_000);
const BodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('save'), versionId: UUID, month: z.string().max(7), glAccountId: UUID,
    cc1Id: UUID.nullable().default(null), cc2Id: UUID.nullable().default(null), buId: UUID.nullable().default(null),
    text: Text,
  }).strict(),
  z.object({ action: z.literal('approve'), id: UUID, text: Text.optional() }).strict(),
  z.object({ action: z.literal('reject'), id: UUID }).strict(),
]);
const QuerySchema = z.object({ versionId: UUID, month: z.string().max(7) });

function fail(res: NextApiResponse, code: VarianceFailureCode, reason: string): void {
  if (code === 'forbidden') return apiResponse.forbidden(res, reason);
  if (code === 'not_found') return apiResponse.error(res, ErrorCode.NOT_FOUND, reason);
  if (code === 'invalid_state') return apiResponse.conflict(res, reason);
  return apiResponse.badRequest(res, reason);
}

async function limited(res: NextApiResponse, key: string, max: number): Promise<boolean> {
  if (await checkRateLimit(key, { max, windowSecs: 60 })) return false;
  res.setHeader('Retry-After', '60');
  apiResponse.tooManyRequests(res, 'Too many variance-note requests; wait a minute and try again.');
  return true;
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId, companyRole, user } = req as CompanyAuthedRequest;
  if (req.method === 'GET') {
    if (await limited(res, `variance-notes-read:${user.id}`, 240)) return;
    const q = QuerySchema.safeParse({ versionId: req.query.versionId, month: req.query.month });
    if (!q.success) return apiResponse.zodValidationError(res, q.error);
    const out = await listVarianceNotes(companyId, companyRole, q.data.versionId, q.data.month);
    if (!out.ok) return fail(res, out.code, out.reason);
    return apiResponse.success(res, { notes: out.notes });
  }
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
  if (await limited(res, `variance-notes-write:${user.id}`, 60)) return;
  const parsed = BodySchema.safeParse(req.body);
  if (!parsed.success) return apiResponse.zodValidationError(res, parsed.error);
  const actor = { userId: user.id, role: companyRole };
  const body = parsed.data;
  const out = body.action === 'save'
    ? await saveVarianceNote(companyId, actor, body)
    : body.action === 'approve'
      ? await approveVarianceNote(companyId, actor, body.id, body.text)
      : await rejectVarianceNote(companyId, actor, body.id);
  if (!out.ok) return fail(res, out.code, out.reason);
  return apiResponse.success(res, { note: out.note });
}

// withWriteAccess: POST needs a write role (owner/admin/manager); the service narrows approve/reject to
// owner/admin. GET passes it, as every read does, and the service decides what each role sees.
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
