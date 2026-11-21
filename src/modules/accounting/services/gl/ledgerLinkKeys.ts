/**
 * Migration 1018's per-journal link key (`ledger_link_key`), taken by a reversal link (in sorted uuid order, for the
 * contra, the journal reversed and the chain root), by a document linking or releasing its journal, and by the deferred
 * line check (gl_jl_linked_account_check) for each changed line's journal at COMMIT, one line at a time in line order.
 */
import { sql } from '@/lib/neon';

/**
 * Round 12 L3: before a bulk line move (the account merge), take the link keys of every journal with a line on the
 * account, in sorted uuid order: the order a reversal link takes them. The deferred check later asks for keys already
 * held, so a merge and a link wait for one another instead of deadlocking (40P01).
 */
export async function lockLinkKeysOfAccountJournals(companyId: string, accountId: string): Promise<void> {
  await sql`
    SELECT pg_advisory_xact_lock(public.ledger_link_key(j.id))
      FROM (SELECT DISTINCT journal_entry_id AS id FROM gl_journal_lines
             WHERE company_id = ${companyId}::UUID AND gl_account_id = ${accountId}::UUID
             ORDER BY 1 OFFSET 0) j
  `;
}
