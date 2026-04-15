/**
 * Journal Entries Report API
 * GET /api/accounting/reports-journal-entries
 * Supports: date_from, date_to, status, source, limit, offset
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { GLEntryStatus, GLEntrySource } from '@/modules/accounting/types/gl.types';

interface ReportRow {
  id: string;
  entry_number: string;
  entry_date: Date | string;
  description: string | null;
  source: string;
  status: string;
  total_debits: string;
  total_credits: string;
}

function fmtDateStr(val: Date | string | null | undefined): string {
  if (!val) return '';
  if (val instanceof Date) return val.toISOString().split('T')[0]!;
  return String(val).split('T')[0]!;
}

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { date_from, date_to, status, source, limit: limitParam = '200', offset: offsetParam = '0' } = req.query;

  const limit = Math.min(Number(limitParam), 500);
  const offset = Number(offsetParam);

  const statusVal = typeof status === 'string' && status ? status as GLEntryStatus : null;
  const sourceVal = typeof source === 'string' && source ? source as GLEntrySource : null;
  const dateFrom = typeof date_from === 'string' && date_from ? date_from : null;
  const dateTo = typeof date_to === 'string' && date_to ? date_to : null;

  try {
    // Build query with all optional filters using conditional sql fragments
    const rows = (await sql`
      SELECT
        je.id,
        je.entry_number,
        je.entry_date,
        je.description,
        je.source,
        je.status,
        COALESCE(SUM(jl.debit), 0)  AS total_debits,
        COALESCE(SUM(jl.credit), 0) AS total_credits
      FROM gl_journal_entries je
      LEFT JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id AND jl.company_id = ${companyId}::UUID
      WHERE je.company_id = ${companyId}
        AND (${statusVal}::TEXT IS NULL OR je.status = ${statusVal})
        AND (${sourceVal}::TEXT IS NULL OR je.source = ${sourceVal})
        AND (${dateFrom}::DATE IS NULL OR je.entry_date >= ${dateFrom}::DATE)
        AND (${dateTo}::DATE IS NULL OR je.entry_date <= ${dateTo}::DATE)
      GROUP BY je.id, je.entry_number, je.entry_date, je.description, je.source, je.status
      ORDER BY je.entry_date DESC, je.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `) as ReportRow[];

    const countRows = (await sql`
      SELECT COUNT(*) AS cnt
      FROM gl_journal_entries je
      WHERE je.company_id = ${companyId}
        AND (${statusVal}::TEXT IS NULL OR je.status = ${statusVal})
        AND (${sourceVal}::TEXT IS NULL OR je.source = ${sourceVal})
        AND (${dateFrom}::DATE IS NULL OR je.entry_date >= ${dateFrom}::DATE)
        AND (${dateTo}::DATE IS NULL OR je.entry_date <= ${dateTo}::DATE)
    `) as { cnt: string }[];

    const entries = rows.map(r => ({
      id: r.id,
      entryNumber: r.entry_number,
      entryDate: fmtDateStr(r.entry_date),
      description: r.description ?? '',
      source: r.source,
      status: r.status,
      totalDebits: Number(r.total_debits),
      totalCredits: Number(r.total_credits),
    }));

    return apiResponse.success(res, {
      entries,
      total: Number(countRows[0]?.cnt ?? 0),
    });
  } catch (err) {
    log.error('Failed to load journal entries report', { error: err }, 'reports-journal-entries');
    return apiResponse.internalError(res, 'Failed to load journal entries report');
  }
}

export default withCompany(withErrorHandler(handler as any));
