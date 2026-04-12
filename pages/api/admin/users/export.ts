/**
 * Admin Users CSV Export
 * GET /api/admin/users/export
 * Streams all users as a CSV file with optional is_active and role filters.
 */

import type { NextApiResponse } from 'next';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';

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

function escapeCell(value: unknown): string {
  if (value == null) return '""';
  const str = String(value);
  return `"${str.replace(/"/g, '""')}"`;
}

function toIsoOrEmpty(value: unknown): string {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  const { is_active, role } = req.query;

  // is_active filter: 'true' | 'false' | undefined (all)
  const isActiveFilter: boolean | null =
    is_active === 'true'  ? true  :
    is_active === 'false' ? false :
    null;

  const roleFilter = typeof role === 'string' && role.trim() ? role.trim() : null;

  const today = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="users-${today}.csv"`);
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-store');

  res.write(CSV_HEADERS.map(escapeCell).join(',') + '\n');

  const CHUNK_SIZE = 500;
  let offset = 0;
  let written = 0;

  try {
    while (true) {
      const rows = await sql`
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
        WHERE (${isActiveFilter}::boolean IS NULL OR u.is_active = ${isActiveFilter})
          AND (${roleFilter}::text IS NULL OR u.role = ${roleFilter})
        ORDER BY u.created_at DESC
        LIMIT ${CHUNK_SIZE} OFFSET ${offset}
      `;

      if (rows.length === 0) break;

      const lines = (rows as Row[]).map((r) => [
        r.id,
        r.email,
        r.first_name ?? '',
        r.last_name  ?? '',
        r.role,
        r.is_active ? 'true' : 'false',
        r.company_name ?? '',
        toIsoOrEmpty(r.last_login),
        toIsoOrEmpty(r.created_at),
      ].map(escapeCell).join(','));

      res.write(lines.join('\n') + '\n');
      written += rows.length;
      offset  += CHUNK_SIZE;

      if (rows.length < CHUNK_SIZE) break;
    }

    log.info(`users/export: wrote ${written} rows`, { isActiveFilter, roleFilter }, 'admin-export');
  } catch (err) {
    log.error('users/export failed', { error: err }, 'admin-export');
  }

  res.end();
}

export default withAdmin(handler);
