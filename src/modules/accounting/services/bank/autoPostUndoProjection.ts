/**
 * R-079 — what "undo anyway" would leave on the books, shown before anyone
 * confirms it. The posting is reversed; everything else stands.
 *
 * Real BALANCES, not a sum of two journals: `now` is the net of every POSTED
 * line on the account, and `afterUndo` is that minus the posting's own effect.
 * So a second correction, a journal already declared unrelated, or another
 * line of the run is in both columns by construction — the round-3 review
 * showed a posting-plus-one-journal sum reading "E1 60 → 0" while the ledger
 * went 0 → −60. For a reclass or a partial correction this is where the
 * double correction becomes visible: the posting's account goes negative.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

export interface UndoProjectionLine {
  accountCode: string;
  accountName: string;
  now: number;
  afterUndo: number;
}

/** Every account the posting or the journal touches: its balance now, and after the posting is reversed. */
export async function projectUndo(companyId: string, postingJeId: string, journalId: string): Promise<UndoProjectionLine[]> {
  const rows = (await sql`
    WITH touched AS (
      SELECT DISTINCT gl_account_id FROM gl_journal_lines
      WHERE company_id = ${companyId}::UUID AND journal_entry_id IN (${postingJeId}::UUID, ${journalId}::UUID)
    ),
    balance AS (
      SELECT l.gl_account_id,
        SUM(l.debit - l.credit) AS now,
        SUM(CASE WHEN l.journal_entry_id = ${postingJeId}::UUID THEN 0 ELSE l.debit - l.credit END) AS after_undo
      FROM gl_journal_lines l
      JOIN gl_journal_entries je ON je.id = l.journal_entry_id AND je.status = 'posted'
      WHERE l.company_id = ${companyId}::UUID AND l.gl_account_id IN (SELECT gl_account_id FROM touched)
      GROUP BY l.gl_account_id
    )
    SELECT a.account_code, a.account_name,
      COALESCE(b.now, 0)::float8 AS now, COALESCE(b.after_undo, 0)::float8 AS after_undo
    FROM touched t
    JOIN gl_accounts a ON a.id = t.gl_account_id AND a.company_id = ${companyId}::UUID
    LEFT JOIN balance b ON b.gl_account_id = t.gl_account_id
    ORDER BY a.account_code
  `) as DbRow[];
  return rows.map((r) => ({
    accountCode: String(r.account_code), accountName: String(r.account_name),
    now: Number(r.now), afterUndo: Number(r.after_undo),
  }));
}
