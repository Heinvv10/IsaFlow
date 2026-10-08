/**
 * Journal Entries API
 * GET  /api/accounting/journal-entries - List entries (with filters)
 * POST /api/accounting/journal-entries - Create draft entry with lines
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { apiResponse } from '@/lib/apiResponse';
import { JOURNAL_DATE_REFUSED, withJournalDateRefusal } from '@/lib/apiJournalDate';
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
import { markCreatedManualJournal } from '@/modules/accounting/services/gl/manualJournalApproval';

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

    // `source` names the SUBSYSTEM that produced the entry, and this route is
    // the manual one. It used to pass whatever the body said straight into the
    // INSERT, checked only by the table's CHECK constraint: with
    // `source = 'auto_expense_receipt'` a hand-made journal lands inside
    // `uq_gl_je_capture_source_document` (a 23505 whose raw Postgres text came
    // back as a 400), and with any other `auto_*` value it creates a live
    // journal against an already-claimed captured document, outside both the
    // index and the posting claim — a second VAT-bearing entry for one receipt,
    // reached by a route the capture fence does not know about. Every `auto_*`
    // source belongs to the service that writes it; this route writes 'manual'.
    if (source !== undefined && source !== null && source !== 'manual') {
      return apiResponse.badRequest(
        res,
        `source '${String(source)}' is written by the subsystem that owns it — a journal created here is 'manual'`,
      );
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

    const entry = await withJournalDateRefusal(res, () => createJournalEntry(companyId, {
      entryDate,
      description,
      source,
      sourceDocumentId,
      fiscalPeriodId,
      lines,
      // A person drafting: a journal dated in a filed VAT period whose only VAT
      // is input tax may be drafted; posting it claims the VAT late (s16(3)).
    }, userId, undefined, { allowLateInputClaim: true }));
    if (entry === JOURNAL_DATE_REFUSED) return;
    // R-035 PR6: a person composed it — marked under manual-journal enforcement.
    await markCreatedManualJournal(companyId, entry.id);

    return apiResponse.success(res, entry);
  } catch (err) {
    if (respondIfLockTimeout(res, err)) return;
    // A driver error (5-character SQLSTATE) quotes the value and names the type
    // ('invalid input syntax for type date: "garbage"'): never the body. Classes
    // 22 (a value Postgres cannot read) and 23 (a value a constraint refuses) come
    // from what the caller sent, raised inside the savepoint above before anything
    // is kept: 400, naming a field only when the code says which (22007/22008: a
    // date, and entryDate is the journal's only one). Any other driver error is
    // the server's, and goes on to the 500 that rolls the request back.
    // 23505 is a clash with a row written at the same moment (a number, a claimed document): 409, retry.
    // withErrorHandler logs what it answers 500, so only the 4xx answers are logged here.
    const sqlState = (err as { code?: unknown }).code;
    if (typeof sqlState === 'string' && /^[0-9A-Z]{5}$/.test(sqlState)) {
      if (!sqlState.startsWith('22') && !sqlState.startsWith('23')) throw err;
      log.warn('Journal entry refused by the database', { sqlState, error: err }, 'accounting-api');
      if (sqlState === '23505') {
        return apiResponse.conflict(res, 'This journal entry clashed with one recorded at the same moment. Nothing was saved — try again.');
      }
      return apiResponse.badRequest(res, sqlState === '22007' || sqlState === '22008'
        ? 'entryDate must be a real date (YYYY-MM-DD)'
        : 'A value in the journal entry is not valid: check its accounts, dimensions, amounts and descriptions');
    }
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
