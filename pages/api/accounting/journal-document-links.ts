/**
 * Link / unlink a captured document to a POSTED journal (migration 706,
 * VAT-gaps batch item 1). Clears/restores `unsupportedInputVat` for that
 * journal (reports/vatInputSupport.ts).
 *
 * GET  ?journal_entry_id=X[&q=search]  — the journal's active link(s) plus
 *      candidate documents to pick from (company-scoped, not already claimed).
 * POST { action: 'link' | 'unlink', journalEntryId, capturedDocumentId, reason }
 *      — same write permission as any other journal edit (no extra role,
 *      matching journal-entries-action.ts).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { UUID } from '@/lib/schemas/common';
import {
  linkDocumentToJournal, unlinkDocumentFromJournal, getActiveLinksForJournal, listLinkableDocuments,
  JournalDocumentLinkRefusal,
} from '@/modules/accounting/services/gl/journalDocumentLinkService';

const BodySchema = z.object({
  action: z.enum(['link', 'unlink']),
  journalEntryId: UUID,
  capturedDocumentId: UUID,
  reason: z.string().trim().min(1, 'A reason is required').max(2000),
});

async function getHandler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  const journalEntryId = String(req.query.journal_entry_id ?? '');
  if (!UUID.safeParse(journalEntryId).success) {
    return apiResponse.badRequest(res, 'journal_entry_id must be a UUID');
  }
  const q = typeof req.query.q === 'string' ? req.query.q : undefined;
  const [links, candidates] = await Promise.all([
    getActiveLinksForJournal(companyId, journalEntryId),
    listLinkableDocuments(companyId, q),
  ]);
  return apiResponse.success(res, { links, candidates });
}

async function postHandler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;

  const parsed = BodySchema.safeParse(req.body);
  if (!parsed.success) {
    return apiResponse.validationError(res, parsed.error.flatten().fieldErrors as Record<string, string[]>);
  }
  const { action, journalEntryId, capturedDocumentId, reason } = parsed.data;

  try {
    if (action === 'link') {
      const link = await linkDocumentToJournal(companyId, journalEntryId, capturedDocumentId, userId, reason);
      log.info('Journal document link created via API', { companyId, journalEntryId }, 'accounting-api');
      return apiResponse.success(res, { link });
    }
    await unlinkDocumentFromJournal(companyId, journalEntryId, capturedDocumentId, userId, reason);
    log.info('Journal document link removed via API', { companyId, journalEntryId }, 'accounting-api');
    return apiResponse.success(res, { unlinked: true });
  } catch (err) {
    if (err instanceof JournalDocumentLinkRefusal) return apiResponse.badRequest(res, err.message);
    throw err;
  }
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') return getHandler(req, res);
  if (req.method === 'POST') return postHandler(req, res);
  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
