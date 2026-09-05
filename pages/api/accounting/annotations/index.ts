/**
 * GET  /api/accounting/annotations?rowIds=&from=&to=  — notes on the rendered rows
 * POST /api/accounting/annotations                    — add a note to one row
 *
 * INTERNAL ONLY. There is no unauthenticated counterpart to this route and the
 * share page never calls it: annotations are colleagues' working notes, and a
 * share link must not be able to reach them.
 *
 * The company comes from the authenticated session on both verbs. Nothing in
 * the query string or the body can name a company, and the author is the
 * caller — a body field claiming a different author is ignored, not honoured.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withCsrf, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { checkReportRateLimit } from '@/lib/rateLimit';
import {
  createAnnotation, listAnnotations, MAX_ROW_IDS,
} from '@/modules/accounting/services/annotations/annotationService';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Same shape as parseSharePackParams' date guard: the pattern alone accepts
 *  2026-02-31, so the round trip through Date is what rejects it. */
function isIsoDate(v: unknown): v is string {
  if (typeof v !== 'string' || !ISO_DATE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** Row ids are opaque strings from the adapter (`acc:4000`, `total:grossProfit`).
 *  They are parameterised into the query, so the only guard needed here is a
 *  length bound — an unbounded id list is a way to make one request read the
 *  whole table. */
function parseRowIds(raw: unknown): string[] | null {
  const list = typeof raw === 'string' ? raw.split(',') : Array.isArray(raw) ? raw : null;
  if (list === null) return null;
  const ids = list.map(String).map(s => s.trim()).filter(s => s.length > 0 && s.length <= 200);
  return ids.slice(0, MAX_ROW_IDS);
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId, user } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    const rowIds = parseRowIds(req.query.rowIds);
    const { from, to } = req.query;
    if (rowIds === null) return apiResponse.badRequest(res, 'rowIds is required');
    if (!isIsoDate(from) || !isIsoDate(to)) return apiResponse.badRequest(res, 'from and to must be YYYY-MM-DD dates');
    return apiResponse.success(res, { annotations: await listAnnotations(companyId, rowIds, from, to) });
  }

  if (req.method === 'POST') {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const rowId = typeof body.rowId === 'string' ? body.rowId.trim() : '';
    const text = typeof body.body === 'string' ? body.body.trim() : '';
    if (rowId.length === 0 || rowId.length > 200) return apiResponse.badRequest(res, 'rowId is required');
    if (text.length === 0) return apiResponse.badRequest(res, 'body is required');
    if (!isIsoDate(body.periodStart) || !isIsoDate(body.periodEnd)) {
      return apiResponse.badRequest(res, 'periodStart and periodEnd must be YYYY-MM-DD dates');
    }
    if (body.periodStart > body.periodEnd) return apiResponse.badRequest(res, 'periodStart must not be after periodEnd');

    if (!(await checkReportRateLimit(companyId, 'annotation-create'))) {
      log.warn('Annotation create rate limit exceeded', { companyId, userId: user.id }, 'rateLimit');
      return apiResponse.tooManyRequests(res, 'Too many notes. Please try again shortly.');
    }

    const annotation = await createAnnotation({
      companyId,
      userId: user.id,
      authorName: user.email ?? null,
      rowId,
      periodStart: body.periodStart,
      periodEnd: body.periodEnd,
      body: text,
    });
    return apiResponse.created(res, { annotation });
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
