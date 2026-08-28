/**
 * Agent activity — what the MCP agent posted, for review and bulk correction.
 *
 * The safety model for agent writes is attribution + review rather than
 * per-action confirmation: every MCP posting carries posting_agent
 * 'mcp:<tool>:v1', so this query answers "what did the agent do" and feeds
 * the decision to reverse.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';

export interface AgentPosting {
  journalEntryId: string;
  entryNumber: string;
  entryDate: string;
  description: string;
  postingAgent: string;
  /** Ledger status. A reversed entry STAYS 'posted' — see `reversed`. */
  status: string;
  /**
   * True once a contra has been posted against this entry.
   *
   * Reversal here is metadata (reversed_at), never a status flip — flipping it
   * dropped the original out of posted-only reports while the contra stayed,
   * driving accounts to the negative of the original
   * (journalEntryPostingService). So `status` cannot distinguish a live agent
   * posting from one already corrected, and reversing twice throws.
   */
  reversed: boolean;
  /** Set when this row is ITSELF the contra of another entry. */
  reversalOfId: string | null;
  amount: number;
}

export async function listAgentPostings(
  companyId: string,
  fromDate: string,
  toDate: string,
  limit = 50,
): Promise<AgentPosting[]> {
  const rows = (await sql`
    SELECT je.id, je.entry_number, je.entry_date, je.description,
           je.posting_agent, je.status, je.reversed_at, je.reversal_of_id,
           COALESCE(SUM(jl.debit), 0) AS amount
    FROM gl_journal_entries je
    LEFT JOIN gl_journal_lines jl
      ON jl.journal_entry_id = je.id AND jl.company_id = ${companyId}::UUID
    WHERE je.company_id = ${companyId}::UUID
      AND je.posting_agent LIKE 'mcp:%'
      AND je.entry_date >= ${fromDate}::DATE
      AND je.entry_date <= ${toDate}::DATE
    GROUP BY je.id, je.entry_number, je.entry_date, je.description,
             je.posting_agent, je.status, je.reversed_at, je.reversal_of_id
    ORDER BY je.entry_date DESC, je.entry_number DESC
    LIMIT ${limit}
  `) as DbRow[];

  return rows.map((r) => ({
    journalEntryId: String(r.id),
    entryNumber: String(r.entry_number),
    entryDate: fmtDate(r.entry_date),
    description: String(r.description ?? ''),
    postingAgent: String(r.posting_agent ?? ''),
    status: String(r.status ?? ''),
    reversed: r.reversed_at != null,
    reversalOfId: r.reversal_of_id != null ? String(r.reversal_of_id) : null,
    amount: Number(r.amount ?? 0),
  }));
}
