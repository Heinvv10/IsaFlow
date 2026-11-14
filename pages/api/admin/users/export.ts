/**
 * Admin Users CSV Export
 * GET /api/admin/users/export?search=&company=&role=&status=
 * Every user matching the Users list's filters (same predicates as listUsers),
 * as one audited CSV (adminCsvExport.sendAuditedCsv: PII export, audit row first).
 */

import type { NextApiResponse } from 'next';
import type { PlatformAdminRequest } from '@/lib/auth';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { csvRow, queryText, sendAuditedCsv, textFilterSet } from '@/modules/admin/services/adminCsvExport';

type Row = DbRow;

const CSV_HEADERS = [
  'id',
  'email',
  'first_name',
  'last_name',
  'role',
  'is_active',
  'company_name',
  'last_login',
  'created_at',
];

async function handler(req: PlatformAdminRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const search  = queryText(req.query.search);
  const company = queryText(req.query.company);
  const role    = queryText(req.query.role);
  const status  = queryText(req.query.status);
  const searchPattern  = search  ? `%${search}%`  : null;
  const companyPattern = company ? `%${company}%` : null;

  const rows = (await sql`
    SELECT
      u.id,
      u.email,
      u.first_name,
      u.last_name,
      u.role,
      u.is_active,
      (
        SELECT c.name
        FROM company_users cup
        JOIN companies c ON c.id = cup.company_id
        WHERE cup.user_id = u.id
        ORDER BY cup.created_at ASC
        LIMIT 1
      ) AS company_name,
      u.last_login,
      u.created_at
    FROM users u
    WHERE (${searchPattern}::text IS NULL
           OR u.email ILIKE ${searchPattern}
           OR u.first_name ILIKE ${searchPattern}
           OR u.last_name ILIKE ${searchPattern})
      AND (${role}::text IS NULL OR u.role = ${role})
      AND (${status}::text IS NULL
           OR (${status} = 'active'    AND u.is_active = true)
           OR (${status} = 'suspended' AND u.is_active = false))
      AND (${companyPattern}::text IS NULL OR EXISTS (
        SELECT 1 FROM company_users cu4
        JOIN companies c4 ON c4.id = cu4.company_id
        WHERE cu4.user_id = u.id AND c4.name ILIKE ${companyPattern}
      ))
    ORDER BY u.created_at DESC, u.id
  `) as Row[];

  const lines = rows.map((r) => csvRow([
    r.id,
    r.email,
    r.first_name ?? '',
    r.last_name  ?? '',
    r.role,
    r.is_active ? 'true' : 'false',
    r.company_name ?? '',
    r.last_login,
    r.created_at,
  ]));

  log.info(`users/export: ${lines.length} rows`, {}, 'admin-export');
  const today = new Date().toISOString().slice(0, 10);
  await sendAuditedCsv(req, res, {
    export: 'users',
    filename: `users-${today}.csv`,
    filters: { search: textFilterSet(search), company: textFilterSet(company), role, status },
    header: CSV_HEADERS,
    lines,
  });
}

export default withAdmin(handler);
