/**
 * Journal Entries — Audit Trail API
 *
 * Returns automatic (system-generated) journal entries. These entries are
 * intentionally hidden from /api/accounting/journal-entries (which only shows
 * manual journals). This endpoint exposes them for audit and reconciliation.
 *
 * GET /api/accounting/journal-entries-audit
 *   ?source=auto_invoice|auto_supplier_invoice|auto_payroll|...
 *   &fromDate=YYYY-MM-DD&toDate=YYYY-MM-DD
 *   &limit=&offset=
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  try {
    const { source, fromDate, toDate, limit, offset } = req.query;
    const limitNum = Math.min(Number(limit) || 100, 500);
    const offsetNum = Number(offset) || 0;

    const sourceFilter = typeof source === 'string' && source.startsWith('auto_')
      ? source
      : null;
    const from = typeof fromDate === 'string' ? fromDate : null;
    const to = typeof toDate === 'string' ? toDate : null;

    const rows = (await sql`
      SELECT je.id, je.entry_number, je.entry_date, je.description, je.source,
             je.source_document_id, je.status, je.fiscal_period_id,
             je.posted_at, je.created_at,
             (SELECT COUNT(*)::int FROM gl_journal_lines WHERE journal_entry_id = je.id) AS line_count,
             (SELECT SUM(debit)::numeric FROM gl_journal_lines WHERE journal_entry_id = je.id) AS total_debit,
             (SELECT SUM(credit)::numeric FROM gl_journal_lines WHERE journal_entry_id = je.id) AS total_credit
      FROM gl_journal_entries je
      WHERE je.company_id = ${companyId}::UUID
        AND je.source LIKE 'auto_%'
        AND (${sourceFilter}::TEXT IS NULL OR je.source = ${sourceFilter})
        AND (${from}::DATE IS NULL OR je.entry_date >= ${from}::DATE)
        AND (${to}::DATE IS NULL OR je.entry_date <= ${to}::DATE)
      ORDER BY je.entry_date DESC, je.entry_number DESC
      LIMIT ${limitNum} OFFSET ${offsetNum}
    `) as DbRow[];

    const totalRows = (await sql`
      SELECT COUNT(*)::int AS cnt
      FROM gl_journal_entries je
      WHERE je.company_id = ${companyId}::UUID
        AND je.source LIKE 'auto_%'
        AND (${sourceFilter}::TEXT IS NULL OR je.source = ${sourceFilter})
        AND (${from}::DATE IS NULL OR je.entry_date >= ${from}::DATE)
        AND (${to}::DATE IS NULL OR je.entry_date <= ${to}::DATE)
    `) as DbRow[];

    // Counts by source (for filter UI)
    const breakdownRows = (await sql`
      SELECT source, COUNT(*)::int AS cnt
      FROM gl_journal_entries
      WHERE company_id = ${companyId}::UUID AND source LIKE 'auto_%'
      GROUP BY source
      ORDER BY source
    `) as DbRow[];

    const entries = rows.map((r) => ({
      id: String(r.id),
      entryNumber: String(r.entry_number ?? ''),
      entryDate: fmtDate(r.entry_date),
      description: r.description ? String(r.description) : null,
      source: String(r.source),
      sourceDocumentId: r.source_document_id ? String(r.source_document_id) : null,
      status: String(r.status),
      fiscalPeriodId: r.fiscal_period_id ? String(r.fiscal_period_id) : null,
      postedAt: r.posted_at ? String(r.posted_at) : null,
      lineCount: Number(r.line_count),
      totalDebit: Number(r.total_debit || 0),
      totalCredit: Number(r.total_credit || 0),
    }));

    const breakdown = breakdownRows.reduce<Record<string, number>>((acc, r) => {
      acc[String(r.source)] = Number(r.cnt);
      return acc;
    }, {});

    return apiResponse.success(res, {
      entries,
      total: Number(totalRows[0]!.cnt),
      breakdown,
    });
  } catch (err) {
    log.error('Failed to list audit JE', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, 'Failed to list audit trail');
  }
}

export default withAuth(withErrorHandler(handler));
