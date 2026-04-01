/**
 * Manual Disclosure Notes API — WS-7.2
 * POST   /api/accounting/disclosure-notes-manual        — save manual note
 * DELETE /api/accounting/disclosure-notes-manual?id=X  — delete manual note
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  saveManualNote,
  deleteManualNote,
} from '@/modules/accounting/services/disclosureNoteService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;
  const userId = (req as CompanyApiRequest).user?.id ?? '';

  if (req.method === 'POST') {
    const { fiscalYear, noteNumber, title, content } = req.body as {
      fiscalYear?: number;
      noteNumber?: number;
      title?: string;
      content?: string;
    };

    if (!fiscalYear || !noteNumber || !title || !content) {
      return apiResponse.badRequest(res, 'fiscalYear, noteNumber, title and content are required');
    }
    if (title.length > 200) {
      return apiResponse.badRequest(res, 'title must be 200 characters or fewer');
    }

    try {
      await saveManualNote(companyId, fiscalYear, { title, content, noteNumber }, userId);
      log.info('Manual note saved', { companyId, fiscalYear, noteNumber }, 'disclosure-notes-manual-api');
      return apiResponse.success(res, { saved: true });
    } catch (err) {
      log.error('Failed to save manual note', { error: err }, 'disclosure-notes-manual-api');
      return apiResponse.badRequest(res, 'Failed to save note — note number may already exist for this year');
    }
  }

  if (req.method === 'DELETE') {
    const noteId = req.query.id as string;
    if (!noteId) return apiResponse.badRequest(res, 'Note id is required');

    try {
      await deleteManualNote(companyId, noteId);
      log.info('Manual note deleted', { companyId, noteId }, 'disclosure-notes-manual-api');
      return apiResponse.success(res, { deleted: true });
    } catch (err) {
      log.error('Failed to delete manual note', { error: err }, 'disclosure-notes-manual-api');
      return apiResponse.badRequest(res, 'Failed to delete note');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST', 'DELETE']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
