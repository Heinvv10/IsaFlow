/**
 * Provisional-Entry Dismiss Service (A–Z P3.5)
 *
 * Dismissing a provisional bank-posted JE must UNDO it, not just close a
 * modal: the June audit found "Dismiss" showed an "automatic reversal is not
 * yet implemented" toast and left the journal posted forever. This reuses
 * the exact reversal + bank-txn-reset plumbing from autoPostUndoService:
 * reverseJournalEntry posts a net-zero contra (reversed_at metadata
 * semantics), then any bank transaction pointing at the JE returns to the
 * review queue (status 'imported', provisional link cleared).
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { reverseJournalEntry } from '../gl/journalEntryService';
import { lockStandingChainHead } from '../shared/journalChainHead';
import { lockBankTransactionsInIdOrder } from './bankTxLock';
import { underFlowLockBudget } from '../core/rowLockBudget';
import { assertMayReverse, auditedReversal } from './bankReversalGate';

type Row = DbRow;

export interface DismissResult {
  /** The contra posted, or null when the provisional's reversal chain was already out (D8). */
  reversalJournalEntryId: string | null;
  bankTransactionsReset: number;
}

/** Every lock of the dismiss under ONE budget, plain UPDATEs included (D8 round 10, core/rowLockBudget). */
export async function dismissProvisionalEntry(
  companyId: string,
  jeId: string,
  userId: string,
): Promise<DismissResult> {
  return underFlowLockBudget(`Provisional entry ${jeId}`, () => dismissInner(companyId, jeId, userId));
}

async function dismissInner(companyId: string, jeId: string, userId: string): Promise<DismissResult> {
  const jeRows = (await sql`
    SELECT id, needs_evidence, status FROM gl_journal_entries
    WHERE id = ${jeId}::UUID AND company_id = ${companyId}::UUID
    LIMIT 1
  `) as Row[];
  if (jeRows.length === 0) throw new Error(`Journal entry ${jeId} not found`);
  if (!jeRows[0]!.needs_evidence) {
    throw new Error('Journal entry is not provisional — dismiss only applies to provisional entries');
  }

  // At its reversal-chain HEAD (D8): a provisional reversed and re-reversed is
  // back in the ledger through the second contra and stamped reversed; one
  // whose chain is already out reverses nothing and only frees its bank line.
  // (1) THE BANK LINE FIRST, then the head: the canonical order (`bank/.claude.md`) both evidence attaches take
  // — head first deadlocked against the automatic attach (D8 round 6, brk-d8b).
  const lines = (await sql`
    SELECT id FROM bank_transactions
    WHERE provisional_je_id = ${jeId}::UUID AND company_id = ${companyId}::UUID ORDER BY id
  `) as Row[];
  const locked = await lockBankTransactionsInIdOrder(companyId, lines.map((l) => String(l.id)));
  // Re-read under the bank-line locks (D8 round 10, brk-d8c O8): an automatic attach that committed while this
  // waited has evidenced the entry, and the read above is stale.
  const [still] = (await sql`
    SELECT needs_evidence FROM gl_journal_entries WHERE id = ${jeId}::UUID AND company_id = ${companyId}::UUID
  `) as Row[];
  if (!still?.needs_evidence) {
    throw new Error('Journal entry is not provisional — dismiss only applies to provisional entries');
  }
  // Step 2 (Hein, decision 4): dismissing reverses the allocation — under manual_journal enforcement not by an agent,
  // nor by the person who posted it (bar the sole approver); decided under the line locks, before any write.
  const clearances = [];
  for (const line of locked) clearances.push({ id: String(line.id), clearance: await assertMayReverse(companyId, line, jeId, userId) });
  const head = await lockStandingChainHead(companyId, jeId);
  const reversal = head ? await reverseJournalEntry(companyId, head, userId) : null;

  const resetRows = (await sql`
    UPDATE bank_transactions
    SET status = 'imported', provisional_je_id = NULL, updated_at = NOW()
    WHERE provisional_je_id = ${jeId}::UUID AND company_id = ${companyId}::UUID
    RETURNING id
  `) as Row[];

  for (const { id, clearance } of clearances) await auditedReversal(companyId, id, userId, clearance, null);

  log.info(
    'Provisional entry dismissed (reversed)',
    { companyId, jeId, reversalId: reversal?.id ?? null, bankTransactionsReset: resetRows.length },
    'provisional-dismiss',
  );

  return {
    reversalJournalEntryId: reversal ? String(reversal.id) : null,
    bankTransactionsReset: resetRows.length,
  };
}
