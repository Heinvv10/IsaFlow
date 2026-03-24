/**
 * Journal Entries API
 * GET  /api/accounting/journal-entries - List entries (with filters)
 * POST /api/accounting/journal-entries - Create draft entry with lines
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  getJournalEntries,
  createJournalEntry,
} from '@/modules/accounting/services/journalEntryService';
import type { GLEntryStatus, GLEntrySource } from '@/modules/accounting/types/gl.types';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    try {
      const { status, source, fiscal_period_id, limit, offset } = req.query;
      const result = await getJournalEntries({
        status: status as GLEntryStatus | undefined,
        source: source as GLEntrySource | undefined,
        fiscalPeriodId: fiscal_period_id as string | undefined,
        limit: limit ? Number(limit) : undefined,
        offset: offset ? Number(offset) : undefined,
      });
      return apiResponse.success(res, result);
    } catch (err) {
      log.error('Failed to get journal entries', { error: err }, 'accounting-api');
      return apiResponse.badRequest(res, 'Failed to get journal entries');
    }
  }

  if (req.method === 'POST') {
    try {
      const { entryDate, description, source, sourceDocumentId, fiscalPeriodId, lines } = req.body;

      if (!entryDate || !lines || !Array.isArray(lines) || lines.length === 0) {
        return apiResponse.badRequest(res, 'entryDate and lines (non-empty array) are required');
      }

      // User identity comes from JWT (req.user), never from client request body
      const userId = req.user.id;

      const entry = await createJournalEntry({
        entryDate,
        description,
        source,
        sourceDocumentId,
        fiscalPeriodId,
        lines,
      }, userId);

      return apiResponse.success(res, entry);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create journal entry';
      log.error('Failed to create journal entry', { error: err }, 'accounting-api');
      return apiResponse.badRequest(res, message);
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withAuth(withErrorHandler(handler as any));
