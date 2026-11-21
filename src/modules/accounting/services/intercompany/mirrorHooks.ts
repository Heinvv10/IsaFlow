/**
 * The two calls the document services make into the intercompany mirror after their own change has been written (P2). Both run in a
 * SAVEPOINT on the caller's transaction and never throw: a failure is logged at ERROR (with the SQLSTATE only) and the caller's change
 * stands. Both are registered definers (migration 1019) that act for the session company only.
 *
 * Hooks keep INBOX state and the group row's DISPLAY columns only; they never block (each definer has lock_timeout = 2 s) and no figure
 * depends on them: the eliminations of mirrored documents are derived from the ledgers at read time (mirrorEliminations.ts).
 *
 * - `withdrawForCancelledDocument` (the SENDER cancelled a customer invoice / customer credit note): a message the receiver has not
 *   handled is withdrawn (not acceptable, never auto-accepted); one already accepted is stamped `source_cancelled_at` so the receiver's
 *   inbox says "Sender cancelled this document". The receiver's own data is never changed. The sender's group row goes back to unmatched.
 *   The database acts only when the ledger agrees (the document's journal was reversed).
 * - `syncGroupRowFor` (the RECEIVER approved, cancelled or deleted the bill / supplier credit note an accepted message created): the
 *   sender's elimination row is matched only while the receiver's own posted journal for that document nets to the sender's amount (a
 *   variance with a reason otherwise), and unmatched when the document is not approved or the sender's document is cancelled.
 */
import { sql, withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = Record<string, unknown>;

async function run<T>(what: string, companyId: string, id: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await withSavepoint('intercompany_hook', fn);
  } catch (err) {
    log.error(`Intercompany ${what} failed; the document change stands`, { companyId, id, code: (err as { code?: string })?.code ?? null }, 'intercompany');
    return fallback;
  }
}

export function withdrawForCancelledDocument(companyId: string, sourceType: 'customer_invoice' | 'credit_note', sourceId: string): Promise<number> {
  return run('withdrawal', companyId, sourceId, async () => {
    const rows = (await sql`SELECT public.intercompany_withdraw_for_source(${sourceType}, ${sourceId}::UUID) AS n`) as Row[];
    return Number(rows[0]?.n ?? 0);
  }, 0);
}

export function syncGroupRowFor(companyId: string, docType: 'supplier_invoice' | 'credit_note', docId: string): Promise<string | null> {
  return run('group row sync', companyId, docId, async () => {
    const rows = (await sql`SELECT public.intercompany_sync_group_row(${docType}, ${docId}::UUID) AS s`) as Row[];
    return rows[0]?.s == null ? null : String(rows[0].s);
  }, null);
}

/** After ANY reversal of a journal of this company (the journal-entry reversal, MCP, a cancel): what records that journal is re-evaluated by the ledger's parity. */
export function journalChainChanged(companyId: string, journalId: string): Promise<number> {
  return run('journal reversal re-evaluation', companyId, journalId, async () => {
    const rows = (await sql`SELECT public.intercompany_journal_chain_changed(${journalId}::UUID) AS n`) as Row[];
    return Number(rows[0]?.n ?? 0);
  }, 0);
}
