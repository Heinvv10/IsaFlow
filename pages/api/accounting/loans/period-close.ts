/**
 * Loan Period Close API
 * GET  ?month=M&year=YYYY  — list loans with period status for the given month
 * POST { loanIds, month, year } — post GL journals for selected loans (interest accrual + reclassification)
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withWriteAccess } from '@/lib/auth/withWriteAccess';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import {
  listLoansForPeriodClose,
  isPeriodLocked,
} from '@/modules/accounting/services/loans/loanPeriodCloseService';
import { postPeriodJournals } from '@/modules/accounting/services/loans/loanGlPostingService';

interface PostBody {
  loanIds: string[];
  month: number;
  year: number;
}

function toYyyymm(year: number, month: number): string {
  return `${year}${String(month).padStart(2, '0')}`;
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const authedReq = req as CompanyAuthedRequest;
  const { companyId } = authedReq;
  const userId = authedReq.user.id;

  // ── GET ──────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const rawMonth = Number(req.query.month);
    const rawYear = Number(req.query.year);

    const now = new Date();
    const month = rawMonth >= 1 && rawMonth <= 12 ? rawMonth : now.getMonth() + 1;
    const year = rawYear >= 2000 ? rawYear : now.getFullYear();
    const yyyymm = toYyyymm(year, month);

    const locked = await isPeriodLocked(companyId, yyyymm);
    const loans = await listLoansForPeriodClose(companyId, yyyymm);

    return apiResponse.success(res, { yyyymm, month, year, locked, loans });
  }

  // ── POST ─────────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const body = req.body as PostBody;

    if (!Array.isArray(body.loanIds) || body.loanIds.length === 0) {
      return apiResponse.badRequest(res, 'loanIds must be a non-empty array');
    }
    if (!body.month || body.month < 1 || body.month > 12) {
      return apiResponse.badRequest(res, 'month must be 1–12');
    }
    if (!body.year || body.year < 2000) {
      return apiResponse.badRequest(res, 'year must be >= 2000');
    }

    const yyyymm = toYyyymm(body.year, body.month);

    if (await isPeriodLocked(companyId, yyyymm)) {
      return apiResponse.badRequest(res, `Period ${yyyymm} is locked — no further postings allowed`);
    }

    const results: Array<{ loanId: string; journalEntryId: string; narrative: string }> = [];
    const errors: Array<{ loanId: string; error: string }> = [];

    for (const loanId of body.loanIds) {
      // Determine the schedule period number that falls in this yyyymm
      // postPeriodJournals takes a period index; we derive it from the schedule
      // by looking up the first schedule row for this loan in the target yyyymm.
      try {
        // We need the period number — query it directly
        const { sql } = await import('@/lib/neon');
        type Row = Record<string, unknown>;
        const schedRows = (await sql`
          SELECT lsr.period
          FROM loan_schedule_rows lsr
          JOIN loan_schedule_runs lsrun ON lsrun.id = lsr.run_id
          WHERE lsrun.loan_id = ${loanId}
            AND lsrun.company_id = ${companyId}
            AND TO_CHAR(lsr.date, 'YYYYMM') = ${yyyymm}
          ORDER BY lsrun.computed_at DESC NULLS LAST
          LIMIT 1
        `) as Row[];

        if (schedRows.length === 0) {
          errors.push({ loanId, error: `No schedule row found for period ${yyyymm}` });
          continue;
        }

        const period = Number(schedRows[0]!.period);
        const result = await postPeriodJournals(companyId, loanId, period, userId);
        results.push({ loanId: result.loanId, journalEntryId: result.journalEntryId, narrative: result.narrative });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn('Period close posting failed for loan', { loanId, yyyymm, error: msg }, 'loans');
        errors.push({ loanId, error: msg });
      }
    }

    log.info('Period close POST completed', { companyId, yyyymm, posted: results.length, errors: errors.length }, 'loans');
    return apiResponse.success(res, { yyyymm, posted: results, errors });
  }

  return apiResponse.badRequest(res, 'Method not allowed');
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
