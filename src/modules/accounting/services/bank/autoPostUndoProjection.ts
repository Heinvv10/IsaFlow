/**
 * R-079 — what "undo anyway" would leave on the books, shown before anyone
 * confirms it. The posting is reversed; the journal the user declared
 * unrelated stands. For a reclass or a partial correction this is where the
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

/** Each account the posting or the journal touches: posting + journal now, the journal alone after the undo. */
export async function projectUndo(companyId: string, postingJeId: string, journalId: string): Promise<UndoProjectionLine[]> {
  const rows = (await sql`
    SELECT a.account_code, a.account_name,
      SUM(l.debit - l.credit)::float8 AS now,
      SUM(CASE WHEN l.journal_entry_id = ${journalId}::UUID THEN l.debit - l.credit ELSE 0 END)::float8 AS after_undo
    FROM gl_journal_lines l
    JOIN gl_accounts a ON a.id = l.gl_account_id AND a.company_id = ${companyId}::UUID
    WHERE l.company_id = ${companyId}::UUID AND l.journal_entry_id IN (${postingJeId}::UUID, ${journalId}::UUID)
    GROUP BY a.id, a.account_code, a.account_name
    ORDER BY a.account_code
  `) as DbRow[];
  return rows.map((r) => ({
    accountCode: String(r.account_code), accountName: String(r.account_name),
    now: Number(r.now), afterUndo: Number(r.after_undo),
  }));
}

