/**
 * Journal Entries API
 * GET  /api/accounting/journal-entries - List entries (with filters)
 * POST /api/accounting/journal-entries - Create draft entry with lines
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withFlowMeter } from '@/lib/billing/withFlowMeter';
import { getFlowCost } from '@/modules/billing/services/flowOperationCatalog';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import {
  getJournalEntries,
  createJournalEntry,
} from '@/modules/accounting/services/gl/journalEntryService';
import type { GLEntryStatus, GLEntrySource } from '@/modules/accounting/types/gl.types';
import { UUID_RE } from '@/lib/validation';

async function getHandler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  try {
    const { status, source, fiscal_period_id, limit, offset } = req.query;
    const result = await getJournalEntries(companyId, {
      status: status as GLEntryStatus | undefined,
      source: source as GLEntrySource | undefined,
      fiscalPeriodId: fiscal_period_id as string | undefined,
      limit: limit ? Math.min(Number(limit), 200) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
    return apiResponse.success(res, result);
  } catch (err) {
    log.error('Failed to get journal entries', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, 'Failed to get journal entries');
  }
}

async function postHandler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  try {
    const { entryDate, description, source, sourceDocumentId, fiscalPeriodId, lines } = req.body;

    if (!entryDate || !lines || !Array.isArray(lines) || lines.length === 0) {
      return apiResponse.badRequest(res, 'entryDate and lines (non-empty array) are required');
    }

    // sourceDocumentId carries an FK to captured_documents (migration 409), so
    // an id that is not one aborts the INSERT — a 500 saying nothing, from a
    // caller error. Checked here, and scoped by company: an id belonging to
    // another tenant must read as invalid, not silently link this company's
    // journal to their document.
    if (sourceDocumentId !== undefined && sourceDocumentId !== null) {
      if (typeof sourceDocumentId !== 'string' || !UUID_RE.test(sourceDocumentId)) {
        return apiResponse.badRequest(res, 'sourceDocumentId must be a captured document id');
      }
      const owned = (await sql`
        SELECT 1 FROM captured_documents
        WHERE id = ${sourceDocumentId}::UUID AND company_id = ${companyId}::UUID`) as unknown[];
      if (owned.length === 0) {
        return apiResponse.badRequest(res, 'sourceDocumentId must be a captured document id');
      }
    }

    // User identity comes from JWT (req.user), never from client request body
    const userId = req.user.id;

    const entry = await createJournalEntry(companyId, {
      entryDate,
      description,
      source,
      sourceDocumentId,
      fiscalPeriodId,
      lines,
    }, userId);

    return apiResponse.success(res, entry);
  } catch (err) {
    const raw = err instanceof Error ? err.message : '';
    // Postgres column-not-found errors sometimes surface as empty message; fall back to generic
    const message = raw || 'Failed to create journal entry';
    log.error('Failed to create journal entry', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, message);
  }
}

const meteredPost = withFlowMeter('journal.create', getFlowCost('journal.create'))(postHandler);

async function mux(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') return getHandler(req, res);
  if (req.method === 'POST') return meteredPost(req, res);
  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
}


export default withAuth(withErrorHandler(withCsrf(withWriteAccess(mux))));
