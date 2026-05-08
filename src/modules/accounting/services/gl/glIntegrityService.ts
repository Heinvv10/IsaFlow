/**
 * GL integrity checks. Currently: orphan posted journal entries — JEs whose
 * entry_date doesn't fall inside any fiscal_periods row. This invariant
 * matters because every other module assumes "posted JE date ⇒ open period",
 * and the bank-rules pre-flight (getPeriodStatusForDate) only blocks new
 * insertions, not historical ones.
 *
 * Hit on Brightsphere 2026-05-08: 5 auto_bank_recon JEs from 2022 had snuck
 * in during the 13-minute window before PR #111 added the pre-flight check.
 * This service surfaces such drift so it can't sneak up again.
 */

import { sql } from '@/lib/neon';

export interface OrphanJournalEntry {
  id: string;
  entryDate: string;
  status: string;
  source: string;
  description: string;
  createdAt: string;
}

export interface OrphanJournalEntriesResult {
  count: number;
  earliest: string | null;
  latest: string | null;
  entries: OrphanJournalEntry[];
}

/**
 * Find posted journal entries whose entry_date falls outside every
 * fiscal_periods row for the given company.
 *
 * Drafts are excluded — they're discardable and not an integrity concern.
 * Results are ordered oldest-first so the earliest stragglers surface first.
 *
 * @param companyId tenant scope
 * @param limit     cap on returned `entries` (count is unaffected). Default 100.
 */
export async function findOrphanJournalEntries(
  companyId: string,
  limit = 100,
): Promise<OrphanJournalEntriesResult> {
  const summary = (await sql`
    SELECT COUNT(*)::INT                   AS count,
           MIN(je.entry_date)::TEXT        AS earliest,
           MAX(je.entry_date)::TEXT        AS latest
    FROM gl_journal_entries je
    WHERE je.company_id = ${companyId}::UUID
      AND je.status = 'posted'
      AND NOT EXISTS (
        SELECT 1 FROM fiscal_periods fp
        WHERE fp.company_id = je.company_id
          AND fp.start_date <= je.entry_date
          AND fp.end_date   >= je.entry_date
      )
  `) as Record<string, unknown>[];

  const count = Number(summary[0]?.count ?? 0);
  const earliest = summary[0]?.earliest ? String(summary[0].earliest) : null;
  const latest = summary[0]?.latest ? String(summary[0].latest) : null;

  if (count === 0) {
    return { count: 0, earliest: null, latest: null, entries: [] };
  }

  const rows = (await sql`
    SELECT je.id::TEXT              AS id,
           je.entry_date::TEXT      AS entry_date,
           je.status                AS status,
           je.source                AS source,
           je.description           AS description,
           je.created_at::TEXT      AS created_at
    FROM gl_journal_entries je
    WHERE je.company_id = ${companyId}::UUID
      AND je.status = 'posted'
      AND NOT EXISTS (
        SELECT 1 FROM fiscal_periods fp
        WHERE fp.company_id = je.company_id
          AND fp.start_date <= je.entry_date
          AND fp.end_date   >= je.entry_date
      )
    ORDER BY je.entry_date
    LIMIT ${limit}
  `) as Record<string, unknown>[];

  const entries: OrphanJournalEntry[] = rows.map(r => ({
    id: String(r.id),
    entryDate: String(r.entry_date),
    status: String(r.status),
    source: String(r.source),
    description: String(r.description ?? ''),
    createdAt: String(r.created_at),
  }));

  return { count, earliest, latest, entries };
}
