/**
 * PRD-060: FibreFlow Accounting Module — Phase 4
 * Bank Reconciliation Service — reconciliation CRUD, allocation, and auto-match
 */

import { sql, withTransaction } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { log } from '@/lib/logger';
import { runAutoMatch } from '../../utils/autoMatch';
import { createJournalEntry, postJournalEntry } from '../gl/journalEntryService';
import { matchTransaction, BankTransactionAllocatedError } from './bankTransactionQueryService';
import type { BankReconciliation, AutoMatchResult } from '../../types/bank.types';
import type { JournalLineInput } from '../../types/gl.types';
import type { DbRow } from '@/types/db';
import { isBankSubtype } from '../gl/accountSubtypes';


// ── Reconciliation CRUD ───────────────────────────────────────────────────────

export async function getReconciliations(
  companyId: string, bankAccountId?: string
): Promise<BankReconciliation[]> {
  try {
    const rows = bankAccountId
      ? (await sql`
          SELECT br.*, ga.account_name AS bank_account_name,
            ga.parent_account_id AS group_id,
            pa.account_name AS group_name,
            pa.account_subtype AS parent_subtype,
            (SELECT COUNT(*) FROM bank_transactions WHERE reconciliation_id = br.id AND status = 'matched') AS matched_count,
            (SELECT COUNT(*) FROM bank_transactions WHERE reconciliation_id = br.id AND status = 'imported') AS unmatched_count
          FROM bank_reconciliations br
          LEFT JOIN gl_accounts ga ON ga.id = br.bank_account_id AND ga.company_id = ${companyId}
          LEFT JOIN gl_accounts pa ON pa.id = ga.parent_account_id AND pa.company_id = ga.company_id
          WHERE br.company_id = ${companyId} AND br.bank_account_id = ${bankAccountId}::UUID
          ORDER BY br.statement_date DESC`) as DbRow[]
      : (await sql`
          SELECT br.*, ga.account_name AS bank_account_name,
            ga.parent_account_id AS group_id,
            pa.account_name AS group_name,
            pa.account_subtype AS parent_subtype,
            (SELECT COUNT(*) FROM bank_transactions WHERE reconciliation_id = br.id AND status = 'matched') AS matched_count,
            (SELECT COUNT(*) FROM bank_transactions WHERE reconciliation_id = br.id AND status = 'imported') AS unmatched_count
          FROM bank_reconciliations br
          LEFT JOIN gl_accounts ga ON ga.id = br.bank_account_id AND ga.company_id = ${companyId}
          LEFT JOIN gl_accounts pa ON pa.id = ga.parent_account_id AND pa.company_id = ga.company_id
          WHERE br.company_id = ${companyId}
          ORDER BY br.statement_date DESC`) as DbRow[];
    return rows.map(mapReconRow);
  } catch (err) {
    log.error('Failed to get reconciliations', { error: err }, 'accounting');
    throw err;
  }
}

export async function getReconciliationById(
  companyId: string, id: string
): Promise<BankReconciliation | null> {
  try {
    const rows = (await sql`
      SELECT br.*, ga.account_name AS bank_account_name,
        (SELECT COUNT(*) FROM bank_transactions WHERE reconciliation_id = br.id AND status = 'matched') AS matched_count,
        (SELECT COUNT(*) FROM bank_transactions WHERE reconciliation_id = br.id AND status = 'imported') AS unmatched_count
      FROM bank_reconciliations br
      LEFT JOIN gl_accounts ga ON ga.id = br.bank_account_id
      WHERE br.id = ${id}::UUID AND br.company_id = ${companyId}`) as DbRow[];
    return rows.length > 0 ? mapReconRow(rows[0]!) : null;
  } catch (err) {
    log.error('Failed to get reconciliation', { id, error: err }, 'accounting');
    throw err;
  }
}

export async function startReconciliation(
  companyId: string, bankAccountId: string, statementDate: string,
  statementBalance: number, userId: string
): Promise<BankReconciliation> {
  try {
    const balRows = (await bankGlBalanceAsAt(
      companyId, sql`${bankAccountId}::UUID`, sql`${statementDate}`)) as DbRow[];
    const glBalance = Number(balRows[0]!.gl_balance);

    // INSERT and the subsequent bank_transactions UPDATE must be atomic.
    // If the UPDATE fails after the INSERT, transactions would be orphaned
    // with no reconciliation_id and would be silently skipped in future runs.
    const recon = await withTransaction(async (tx) => {
      const rows = (await tx`
        INSERT INTO bank_reconciliations (
          company_id, bank_account_id, statement_date, statement_balance, gl_balance,
          reconciled_balance, started_by
        ) VALUES (
          ${companyId}, ${bankAccountId}::UUID, ${statementDate}, ${statementBalance},
          ${glBalance}, ${glBalance}, ${userId}::UUID
        ) RETURNING *`) as DbRow[];
      // BL-82: guard by company_id to prevent cross-tenant UPDATE
      await tx`
        UPDATE bank_transactions SET reconciliation_id = ${rows[0]!.id}::UUID
        WHERE bank_account_id = ${bankAccountId}::UUID
          AND company_id = ${companyId}::UUID
          AND status = 'imported' AND reconciliation_id IS NULL`;
      return rows[0]!;
    });
    log.info('Started bank reconciliation', {
      id: String(recon.id), bankAccountId, statementBalance, glBalance,
    }, 'accounting');
    return mapReconRow(recon);
  } catch (err) {
    log.error('Failed to start reconciliation', { error: err }, 'accounting');
    throw err;
  }
}

export async function completeReconciliation(
  companyId: string, id: string, userId: string
): Promise<BankReconciliation> {
  try {
    const recon = await getReconciliationById(companyId, id);
    if (!recon) throw new Error(`Reconciliation ${id} not found`);
    if (recon.status === 'completed') throw new Error('Reconciliation already completed');
    if (Math.abs(recon.difference) > 0.01) {
      throw new Error(`Cannot complete: difference is R${recon.difference.toFixed(2)} (must be R0.00)`);
    }
    // Both UPDATEs must be atomic: if the reconciliation header update fails
    // after transactions are marked 'reconciled', they become stuck in a
    // terminal state with no completed reconciliation to reference them.
    const completedRow = await withTransaction(async (tx) => {
      // BL-83: defense-in-depth company_id guard on bank_transactions UPDATE
      await tx`
        UPDATE bank_transactions SET status = 'reconciled'
        WHERE reconciliation_id = ${id}::UUID AND status = 'matched'
          AND company_id = ${companyId}::UUID`;
      const rows = (await tx`
        UPDATE bank_reconciliations
        SET status = 'completed', completed_by = ${userId}::UUID, completed_at = NOW()
        WHERE id = ${id}::UUID AND company_id = ${companyId} RETURNING *`) as DbRow[];
      return rows[0]!;
    });
    log.info('Completed bank reconciliation', { id }, 'accounting');
    return mapReconRow(completedRow);
  } catch (err) {
    log.error('Failed to complete reconciliation', { id, error: err }, 'accounting');
    throw err;
  }
}

export async function createAdjustmentEntry(
  companyId: string, reconciliationId: string, bankAccountId: string,
  contraAccountId: string, amount: number, description: string, userId: string
): Promise<string> {
  try {
    const lines: JournalLineInput[] = amount > 0
      ? [{ glAccountId: bankAccountId, debit: amount, credit: 0, description },
         { glAccountId: contraAccountId, debit: 0, credit: amount, description }]
      : [{ glAccountId: contraAccountId, debit: Math.abs(amount), credit: 0, description },
         { glAccountId: bankAccountId, debit: 0, credit: Math.abs(amount), description }];
    const recon = await getReconciliationById(companyId, reconciliationId);
    if (!recon) throw new Error(`Reconciliation ${reconciliationId} not found`);
    // A completed reconciliation is an audit artefact: its balances record what
    // the ledger said at sign-off and must not be rewritten by a later adjustment.
    if (recon.status === 'completed') {
      throw new Error('Cannot adjust a completed reconciliation');
    }
    // updateReconciledBalance recomputes from the reconciliation's OWN bank
    // account, so an adjustment posted to a different one would post a journal
    // and silently leave the difference untouched.
    if (bankAccountId !== recon.bankAccountId) {
      throw new Error('Adjustment bank account does not match the reconciliation');
    }
    const je = await createJournalEntry(companyId, {
      entryDate: recon.statementDate,
      description: `Bank recon adjustment: ${description}`,
      // source_record_id, NOT source_document_id: the latter FKs to
      // captured_documents (migration 409) and a reconciliation id throws on it.
      source: 'auto_bank_recon', sourceRecordId: reconciliationId, lines,
    }, userId);
    await postJournalEntry(companyId, je.id, userId);
    await updateReconciledBalance(companyId, reconciliationId);
    log.info('Created adjustment entry', { reconciliationId, journalEntryId: je.id }, 'accounting');
    return je.id;
  } catch (err) {
    log.error('Failed to create adjustment entry', { error: err }, 'accounting');
    throw err;
  }
}

// ── Auto-Match ────────────────────────────────────────────────────────────────

export async function autoMatchTransactions(
  companyId: string, bankAccountId: string, reconciliationId?: string
): Promise<AutoMatchResult> {
  try {
    const bankTxRows = (await sql`
      SELECT id, amount, transaction_date, reference, description
      FROM bank_transactions
      WHERE bank_account_id = ${bankAccountId}::UUID
        AND company_id = ${companyId}::UUID
        AND status = 'imported'
      ORDER BY transaction_date`) as DbRow[];
    if (bankTxRows.length === 0) return { matched: 0, unmatched: 0, candidates: [] };
    const glRows = (await sql`
      SELECT jl.id, jl.debit, jl.credit, jl.description,
        je.entry_date, je.entry_number, je.source_document_id
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      WHERE jl.gl_account_id = ${bankAccountId}::UUID
        AND jl.company_id = ${companyId}::UUID
        AND je.status = 'posted' AND je.company_id = ${companyId}::UUID
        -- company_id on the subquery: unscoped it read every tenant's rows.
        AND jl.id NOT IN (
          SELECT matched_journal_line_id FROM bank_transactions
          WHERE matched_journal_line_id IS NOT NULL
            AND company_id = ${companyId}::UUID)
      ORDER BY je.entry_date`) as DbRow[];
    const bankTxs = bankTxRows.map((r: DbRow) => ({
      id: String(r.id), amount: Number(r.amount), transactionDate: String(r.transaction_date),
      reference: r.reference ? String(r.reference) : undefined,
      description: r.description ? String(r.description) : undefined,
    }));
    const glLines = glRows.map((r: DbRow) => ({
      id: String(r.id), debit: Number(r.debit), credit: Number(r.credit),
      description: r.description ? String(r.description) : undefined,
      entryDate: String(r.entry_date),
      entryNumber: r.entry_number ? String(r.entry_number) : undefined,
      sourceDocumentId: r.source_document_id ? String(r.source_document_id) : undefined,
    }));
    const result = runAutoMatch(bankTxs, glLines);
    let matchedCount = 0;
    let skippedRaced = 0;
    // Locked in transaction-id order: matchTransaction takes a row lock that is
    // held to the end of the request, so a run walking its rows in a different
    // order from a concurrent allocation deadlocks on the pair (40P01).
    const ordered = [...result.matches].sort((a, b) =>
      a.bankTransactionId < b.bankTransactionId ? -1 : a.bankTransactionId > b.bankTransactionId ? 1 : 0);
    for (const match of ordered) {
      if (match.confidence >= 0.9) {
        try {
          await matchTransaction(companyId, match.bankTransactionId, match.journalLineId, reconciliationId);
          matchedCount++;
        } catch (matchErr) {
          // The candidate query read these rows in bulk; one of them has been
          // allocated since. Skip it and keep going — letting it escape would
          // abort the loop, and because withAuth COMMITs on any handler that
          // returns (the route catches and 400s), the matches already applied
          // would persist while the remaining ones were silently dropped.
          // Anything else is a real failure and must still reach the caller.
          if (!(matchErr instanceof BankTransactionAllocatedError)) throw matchErr;
          skippedRaced++;
        }
      }
    }
    const lowConfidence = result.matches.filter(m => m.confidence < 0.9);
    log.info('Auto-match completed', {
      bankAccountId, autoMatched: matchedCount, skippedRaced,
      candidates: lowConfidence.length, unmatched: result.unmatched.length,
    }, 'accounting');
    return {
      matched: matchedCount, unmatched: result.unmatched.length,
      candidates: lowConfidence, skippedRaced,
    };
  } catch (err) {
    log.error('Failed to auto-match transactions', { error: err }, 'accounting');
    throw err;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export async function updateReconciledBalance(companyId: string, reconciliationId: string): Promise<void> {
  // Single atomic UPDATE — avoids race condition from read-then-write pattern.
  // Both the outer UPDATE and inner SELECT are scoped by company_id to prevent
  // cross-tenant contamination if two tenants share a reconciliation_id UUID.
  // K-020: recompute the bank GL balance live as at statement_date rather than
  // adding matched bank amounts to the frozen gl_balance snapshot. Matching only
  // stamps a bank row against an already-posted line, so that movement is already
  // inside the GL balance and adding it counted it twice; the adjustment journal
  // this helper is called to reflect never entered the frozen column at all.
  await sql`
    UPDATE bank_reconciliations br
    SET (gl_balance, reconciled_balance) = (
      SELECT bal.gl_balance, bal.gl_balance
      FROM (${bankGlBalanceAsAt(
        companyId, sql`br.bank_account_id`, sql`br.statement_date`)}) bal
    )
    WHERE br.id = ${reconciliationId}::UUID
      AND br.company_id = ${companyId}::UUID
  `;
}

/**
 * Posted bank-account GL balance as at a date, as a composable fragment.
 * Both the startReconciliation snapshot and the updateReconciledBalance
 * recompute build on this one definition so the two cannot drift — drift
 * between a frozen snapshot and a later figure was defect K-020. The account
 * and date arrive as fragments because the recompute correlates on the
 * reconciliation row's own columns while the snapshot binds parameters.
 */
function bankGlBalanceAsAt(
  companyId: string,
  glAccount: ReturnType<typeof sql>,
  asAtDate: ReturnType<typeof sql>,
): ReturnType<typeof sql> {
  return sql`
    SELECT COALESCE(SUM(jl.debit) - SUM(jl.credit), 0) AS gl_balance
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    WHERE jl.gl_account_id = ${glAccount}
      AND jl.company_id = ${companyId}::UUID
      AND je.status = 'posted' AND je.company_id = ${companyId}::UUID
      AND je.entry_date <= ${asAtDate}`;
}

function mapReconRow(row: DbRow): BankReconciliation {
  return {
    id: String(row.id),
    bankAccountId: String(row.bank_account_id),
    statementDate: fmtDate(row.statement_date),
    statementBalance: Number(row.statement_balance),
    glBalance: Number(row.gl_balance),
    reconciledBalance: Number(row.reconciled_balance),
    difference: Number(row.difference),
    status: String(row.status) as BankReconciliation['status'],
    startedBy: String(row.started_by),
    startedAt: String(row.started_at),
    completedBy: row.completed_by ? String(row.completed_by) : undefined,
    completedAt: row.completed_at ? String(row.completed_at) : undefined,
    notes: row.notes ? String(row.notes) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    bankAccountName: row.bank_account_name ? String(row.bank_account_name) : undefined,
    matchedCount: row.matched_count !== undefined ? Number(row.matched_count) : undefined,
    unmatchedCount: row.unmatched_count !== undefined ? Number(row.unmatched_count) : undefined,
    // Only treat the parent as an umbrella group when it is itself a bank-subtype
    // account (mirrors the bank-accounts grouping rule); otherwise leave ungrouped.
    groupId: isBankSubtype(row.parent_subtype as string | null) && row.group_id ? String(row.group_id) : undefined,
    groupName: isBankSubtype(row.parent_subtype as string | null) && row.group_name ? String(row.group_name) : undefined,
  };
}

// ── Re-exports for backward compatibility ─────────────────────────────────────

export { importBankStatement, importParsedTransactions } from './bankImportService';
export {
  getBankTransactions,
  matchTransaction,
  unmatchTransaction,
  excludeTransaction,
  deleteTransactions,
  bulkAcceptTransactions,
  mapTxRow,
  fmtDate,
} from './bankTransactionQueryService';
export type { BankTxFilters } from './bankTransactionQueryService';
export {
  allocateTransaction, splitAllocateTransaction, reverseReconciledTransaction,
} from './bankAllocationService';
export type { AllocationType, SplitLine } from './bankAllocationService';
