/**
 * Admin Email Log API
 * GET /api/admin/email-log — paginated list with filters + 30-day summary stats
 */

import type { NextApiResponse } from 'next';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import type { EmailLogItem, EmailLogStats, EmailLogResponse } from '@/types/emailLog';

// re-export so the page can import from the API file directly if needed
export type { EmailLogItem, EmailLogStats };

type Row = Record<string, unknown>;

// ─── Handler ──────────────────────────────────────────────────────────────────

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const {
    company_id,
    status,
    email_type,
    date_from,
    date_to,
    search,
    page: pageParam,
    limit: limitParam,
  } = req.query;

  const page  = Math.max(1, parseInt((pageParam  as string) || '1',  10));
  const limit = Math.min(100, Math.max(1, parseInt((limitParam as string) || '25', 10)));
  const offset = (page - 1) * limit;

  try {
    // ── Stats (30 days) ─────────────────────────────────────────────────────
    const statsRows = (await sql`
      SELECT
        COUNT(*) FILTER (WHERE status = 'sent')   AS total_sent,
        COUNT(*) FILTER (WHERE status = 'failed') AS total_failed
      FROM email_log
      WHERE sent_at >= NOW() - INTERVAL '30 days'
    `) as Row[];

    const statsRow  = statsRows[0] ?? {};
    const totalSent = Number(statsRow.total_sent ?? 0);
    const totalFailed = Number(statsRow.total_failed ?? 0);
    const total30d  = totalSent + totalFailed;
    const stats: EmailLogStats = {
      total_sent: totalSent,
      total_failed: totalFailed,
      success_rate: total30d > 0 ? Math.round((totalSent / total30d) * 100 * 10) / 10 : 100,
    };

    // ── Build dynamic WHERE conditions ───────────────────────────────────────
    // Use sql.query() with positional parameters — fully typed, no unsafe cast.
    const conditions: string[] = ['1=1'];
    const bindValues: (string | number | null)[] = [];
    let bindIdx = 1;

    if (company_id) {
      conditions.push(`el.company_id = $${bindIdx}::UUID`);
      bindValues.push(company_id as string);
      bindIdx++;
    }
    if (status && ['sent', 'failed', 'bounced'].includes(status as string)) {
      conditions.push(`el.status = $${bindIdx}`);
      bindValues.push(status as string);
      bindIdx++;
    }
    if (email_type) {
      conditions.push(`el.email_type = $${bindIdx}`);
      bindValues.push(email_type as string);
      bindIdx++;
    }
    if (date_from) {
      conditions.push(`el.sent_at >= $${bindIdx}::TIMESTAMPTZ`);
      bindValues.push(date_from as string);
      bindIdx++;
    }
    if (date_to) {
      conditions.push(`el.sent_at <= $${bindIdx}::TIMESTAMPTZ`);
      bindValues.push(date_to as string);
      bindIdx++;
    }
    if (search) {
      conditions.push(`el.recipient_email ILIKE $${bindIdx}`);
      bindValues.push(`%${(search as string).replace(/[%_]/g, '\\$&')}%`);
      bindIdx++;
    }

    const where = conditions.join(' AND ');

    // ── Count ────────────────────────────────────────────────────────────────
    const countQuery = `SELECT COUNT(*) AS cnt FROM email_log el WHERE ${where}`;
    const countRows = (await sql.query(countQuery, bindValues)) as Row[];
    const totalCount = Number(countRows[0]?.cnt ?? 0);

    // ── Rows ─────────────────────────────────────────────────────────────────
    const limitIdx = bindIdx;
    const offsetIdx = bindIdx + 1;
    const itemQuery = `
      SELECT
        el.id,
        el.company_id,
        co.name          AS company_name,
        el.recipient_email,
        el.subject,
        el.email_type,
        el.status,
        el.error_message,
        el.sent_at,
        el.sent_by
      FROM email_log el
      LEFT JOIN companies co ON co.id = el.company_id
      WHERE ${where}
      ORDER BY el.sent_at DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `;

    const itemRows = (await sql.query(itemQuery, [...bindValues, limit, offset])) as Row[];

    const items: EmailLogItem[] = itemRows.map((r) => ({
      id:              String(r.id ?? ''),
      company_id:      r.company_id != null ? String(r.company_id) : null,
      company_name:    r.company_name != null ? String(r.company_name) : null,
      recipient_email: String(r.recipient_email ?? ''),
      subject:         String(r.subject ?? ''),
      email_type:      String(r.email_type ?? 'other'),
      status:          (r.status ?? 'sent') as EmailLogItem['status'],
      error_message:   r.error_message != null ? String(r.error_message) : null,
      sent_at:         String(r.sent_at ?? ''),
      sent_by:         r.sent_by != null ? String(r.sent_by) : null,
    }));

    const result: EmailLogResponse = { items, total: totalCount, page, limit, stats };
    return apiResponse.success(res, result);

  } catch (err) {
    log.error('email-log API error', { error: err instanceof Error ? err.message : err }, 'admin-email-log');
    return apiResponse.internalError(res, err);
  }
}

export default withAdmin(handler);
