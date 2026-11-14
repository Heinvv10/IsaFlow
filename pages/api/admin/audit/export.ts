/**
 * Admin Audit Trail CSV Export
 * GET /api/admin/audit/export?source=&company_id=&action=&entity_type=&search=&from_date=&to_date=
 *
 * Every entry matching the Audit Trail's filters (getUnifiedAuditLog, `all`), not
 * the page of 50 on screen. One audited CSV (adminCsvExport). Refuses (400) more
 * than MAX_ROWS entries, so a missing date range cannot build an unbounded file in
 * memory; the admin narrows the range instead.
 */
import type { NextApiResponse } from 'next';
import type { PlatformAdminRequest } from '@/lib/auth';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { isRealCalendarDate, isUuidParam } from '@/lib/validation';
import { getUnifiedAuditLog, type UnifiedAuditFilters } from '@/modules/admin/services/auditQueryService';
import { csvRow, queryText, sendAuditedCsv } from '@/modules/admin/services/adminCsvExport';

const MAX_ROWS = 100_000;
const SOURCES = new Set(['admin', 'accounting', 'auth']);

const CSV_HEADERS = ['Date', 'Source', 'User', 'Email', 'Company', 'Action', 'Entity Type', 'Entity Ref', 'IP', 'Details'];

async function handler(req: PlatformAdminRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const source     = queryText(req.query.source);
  const companyId  = queryText(req.query.company_id);
  const action     = queryText(req.query.action);
  const entityType = queryText(req.query.entity_type);
  const search     = queryText(req.query.search);
  const fromDate   = queryText(req.query.from_date);
  const toDate     = queryText(req.query.to_date);
  if (source && !SOURCES.has(source)) return apiResponse.badRequest(res, 'source must be admin, accounting or auth');
  if (companyId && !isUuidParam(companyId)) return apiResponse.badRequest(res, 'company_id must be a UUID');
  for (const d of [fromDate, toDate]) {
    if (d && !isRealCalendarDate(d)) return apiResponse.badRequest(res, 'from_date and to_date must be YYYY-MM-DD');
  }

  const filters: UnifiedAuditFilters = {
    source: (source ?? undefined) as UnifiedAuditFilters['source'],
    company_id: companyId ?? undefined,
    action: action ?? undefined,
    entity_type: entityType ?? undefined,
    search: search ?? undefined,
    from_date: fromDate ?? undefined,
    to_date: toDate ?? undefined,
  };

  const { total } = await getUnifiedAuditLog({ ...filters, limit: 1 });
  if (total > MAX_ROWS) {
    return apiResponse.badRequest(
      res, `${total.toLocaleString('en-ZA')} entries match; narrow the dates to export at most ${MAX_ROWS.toLocaleString('en-ZA')}`);
  }
  const { items } = await getUnifiedAuditLog(filters, { all: true });

  const lines = items.map((r) => csvRow([
    r.created_at,
    r.source,
    r.user_name ?? '',
    r.user_email ?? '',
    r.company_name ?? '',
    r.action,
    r.entity_type ?? '',
    r.entity_ref ?? '',
    r.ip_address ?? '',
    typeof r.details === 'string' ? r.details : JSON.stringify(r.details ?? ''),
  ]));

  await sendAuditedCsv(req, res, {
    export: 'audit',
    filename: `audit-${new Date().toISOString().slice(0, 10)}.csv`,
    filters: {
      source, company_id: companyId, action, entity_type: entityType, search, from_date: fromDate, to_date: toDate,
    },
    header: CSV_HEADERS,
    lines,
  });
}

export default withAdmin(handler);
