// pages/api/accounting/afs/[documentId]/period.ts
// Returns the reporting period (start/end date strings) derived from an AFS document's
// fiscal_year or management_pack period column.
//
// GET /api/accounting/afs/[documentId]/period
// Response: { periodStart: string; periodEnd: string }

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { fiscalYearForDate, getFiscalYear } from '@/modules/accounting/services/gl/fiscalYearRegistry';
import { fmtDate } from '@/lib/fmtDate';

type DocRow = { fiscal_year: number | null; period: string | null; document_type: string };

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const documentId = req.query.documentId as string;

  const rows = (await sql`
    SELECT fiscal_year, period, document_type
    FROM afs_documents
    WHERE id = ${documentId}::UUID
      AND company_id = ${companyId}::UUID
    LIMIT 1
  `) as DocRow[];

  if (!rows.length) {
    return apiResponse.notFound(res, 'AFS document', documentId);
  }

  const doc = rows[0]!;
  let periodStart: string | null = null;
  let periodEnd: string | null = null;

  if (doc.document_type === 'afs' && doc.fiscal_year) {
    // The financial year's own dates (a 14-month transition year included),
    // never January-December of the label.
    const year = await getFiscalYear(companyId, Number(doc.fiscal_year));
    if (year) {
      periodStart = year.startDate;
      periodEnd = year.endDate;
    }
  } else if (doc.document_type === 'management_pack' && doc.period) {
    const [y, m] = doc.period.split('-').map(Number);
    if (y && m) {
      const lastDay = new Date(y, m, 0).getDate();
      periodStart = `${doc.period}-01`;
      periodEnd   = `${doc.period}-${String(lastDay).padStart(2, '0')}`;
    }
  }

  if (periodStart === null || periodEnd === null) {
    // No usable label or period: the financial year holding today.
    const current = await fiscalYearForDate(companyId, fmtDate(new Date()));
    periodStart = current.startDate;
    periodEnd = current.endDate;
  }
  const result = { periodStart, periodEnd };

  log.info('AFS period resolved', { companyId, documentId, ...result }, 'afs-period-api');
  return apiResponse.success(res, result);
}

export default withAuth(withErrorHandler(handler as never));
