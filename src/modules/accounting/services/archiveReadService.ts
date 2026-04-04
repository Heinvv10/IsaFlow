/**
 * Archive Read Service
 * Query archived entries (read-only view into archive tables).
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { toISODate, toStr } from './archiveQueryService';

type Row = Record<string, unknown>;

const COMPONENT = 'data-archiving';

export interface ArchivedEntry {
  id: string;
  entryNumber: string | null;
  entryDate: string;
  description: string | null;
  status: string | null;
  source: string | null;
  createdAt: string;
}

export async function getArchivedEntries(
  companyId: string,
  filters: { dateFrom?: string; dateTo?: string; limit?: number; offset?: number }
): Promise<{ items: ArchivedEntry[]; total: number }> {
  try {
    const limit = Math.min(filters.limit ?? 50, 200);
    const offset = filters.offset ?? 0;
    const dateFrom = filters.dateFrom ?? null;
    const dateTo = filters.dateTo ?? null;

    const rows = (await sql`
      SELECT id, entry_number, entry_date, description, status, source, created_at
      FROM archive_gl_journal_entries
      WHERE company_id = ${companyId}
        AND (${dateFrom}::date IS NULL OR entry_date >= ${dateFrom}::date)
        AND (${dateTo}::date IS NULL OR entry_date <= ${dateTo}::date)
      ORDER BY entry_date DESC
      LIMIT ${limit} OFFSET ${offset}
    `) as Row[];

    const countRows = (await sql`
      SELECT COUNT(*) AS cnt
      FROM archive_gl_journal_entries
      WHERE company_id = ${companyId}
        AND (${dateFrom}::date IS NULL OR entry_date >= ${dateFrom}::date)
        AND (${dateTo}::date IS NULL OR entry_date <= ${dateTo}::date)
    `) as Row[];

    const items: ArchivedEntry[] = rows.map((r: Row): ArchivedEntry => ({
      id: r.id as string,
      entryNumber: r.entry_number as string | null,
      entryDate: toISODate(r.entry_date as string | Date | null) ?? '',
      description: r.description as string | null,
      status: r.status as string | null,
      source: r.source as string | null,
      createdAt: toStr(r.created_at as Date | string),
    }));

    return { items, total: Number(countRows[0]?.cnt ?? 0) };
  } catch (err) {
    log.error('Failed to get archived entries', { companyId, filters, error: err }, COMPONENT);
    throw err;
  }
}
