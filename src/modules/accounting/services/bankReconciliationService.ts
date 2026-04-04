/**
 * PRD-060: FibreFlow Accounting Module — Phase 4
 * Bank Reconciliation Service — reconciliation CRUD, allocation, and auto-match
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { runAutoMatch } from '../utils/autoMatch';
import { createJournalEntry, postJournalEntry } from './journalEntryService';
import { matchTransaction, mapTxRow, fmtDate } from './bankTransactionQueryService';
import type { BankReconciliation, AutoMatchResult } from '../types/bank.types';
import type { JournalLineInput } from '../types/gl.types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

// ── Reconciliation CRUD ───────────────────────────────────────────────────────

export async function getReconciliations(
  companyId: string, bankAccountId?: string
): Promise<BankReconciliation[]> {
  try {
    const rows = bankAccountId
      ? (await sql`
          SELECT br.*, ga.account_name AS bank_account_name,
            (SELECT COUNT(*) FROM bank_transactions WHERE reconciliation_id = br.id AND status = 'matched') AS matched_count,
            (SELECT COUNT(*) FROM bank_transactions WHERE reconciliation_id = br.id AND status = 'imported') AS unmatched_count
          FROM bank_reconciliations br
          LEFT JOIN gl_accounts ga ON ga.id = br.bank_account_id
          WHERE br.company_id = ${companyId} AND br.bank_account_id = ${bankAccountId}::UUID
          ORDER BY br.statement_date DESC`) as Row[]
      : (await sql`
          SELECT br.*, ga.account_name AS bank_account_name,
            (SELECT COUNT(*) FROM bank_transactions WHERE reconciliation_id = br.id AND status = 'matched') AS matched_count,
            (SELECT COUNT(*) FROM bank_transactions WHERE reconciliation_id = br.id AND status = 'imported') AS unmatched_count
          FROM bank_reconciliations br
          LEFT JOIN gl_accounts ga ON ga.id = br.bank_account_id
          WHERE br.company_id = ${companyId}
          ORDER BY br.statement_date DESC`) as Row[];
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
      WHERE br.id = ${id}::UUID AND br.company_id = ${companyId}`) as Row[];
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
    const balRows = (await sql`
      SELECT COALESCE(SUM(jl.debit) - SUM(jl.credit), 0) AS gl_balance
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      WHERE jl.gl_account_id = ${bankAccountId}::UUID
        AND je.status = 'posted' AND je.entry_date <= ${statementDate}`) as Row[];
    const glBalance = Number(balRows[0]!.gl_balance);
    const rows = (await sql`
      INSERT INTO bank_reconciliations (
        company_id, bank_account_id, statement_date, statement_balance, gl_balance,
        reconciled_balance, started_by
      ) VALUES (
        ${companyId}, ${bankAccountId}::UUID, ${statementDate}, ${statementBalance},
        ${glBalance}, ${glBalance}, ${userId}::UUID
      ) RETURNING *`) as Row[];
    await sql`
      UPDATE bank_transactions SET reconciliation_id = ${rows[0]!.id}::UUID
      WHERE bank_account_id = ${bankAccountId}::UUID
        AND status = 'imported' AND reconciliation_id IS NULL`;
    log.info('Started bank reconciliation', {
      id: String(rows[0]!.id), bankAccountId, statementBalance, glBalance,
    }, 'accounting');
    return mapReconRow(rows[0]!);
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
    await sql`UPDATE bank_transactions SET status = 'reconciled'
      WHERE reconciliation_id = ${id}::UUID AND status = 'matched'`;
    const rows = (await sql`
      UPDATE bank_reconciliations
      SET status = 'completed', completed_by = ${userId}::UUID, completed_at = NOW()
      WHERE id = ${id}::UUID AND company_id = ${companyId} RETURNING *`) as Row[];
    log.info('Completed bank reconciliation', { id }, 'accounting');
    return mapReconRow(rows[0]!);
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
    const je = await createJournalEntry(companyId, {
      entryDate: recon.statementDate,
      description: `Bank recon adjustment: ${description}`,
      source: 'auto_bank_recon', sourceDocumentId: reconciliationId, lines,
    }, userId);
    await postJournalEntry('', je.id, userId);
    await updateReconciledBalance(reconciliationId);
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
      WHERE bank_account_id = ${bankAccountId}::UUID AND status = 'imported'
      ORDER BY transaction_date`) as Row[];
    if (bankTxRows.length === 0) return { matched: 0, unmatched: 0, candidates: [] };
    const glRows = (await sql`
      SELECT jl.id, jl.debit, jl.credit, jl.description,
        je.entry_date, je.entry_number, je.source_document_id
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      WHERE jl.gl_account_id = ${bankAccountId}::UUID AND je.status = 'posted'
        AND jl.id NOT IN (
          SELECT matched_journal_line_id FROM bank_transactions
          WHERE matched_journal_line_id IS NOT NULL)
      ORDER BY je.entry_date`) as Row[];
    const bankTxs = bankTxRows.map((r: Row) => ({
      id: String(r.id), amount: Number(r.amount), transactionDate: String(r.transaction_date),
      reference: r.reference ? String(r.reference) : undefined,
      description: r.description ? String(r.description) : undefined,
    }));
    const glLines = glRows.map((r: Row) => ({
      id: String(r.id), debit: Number(r.debit), credit: Number(r.credit),
      description: r.description ? String(r.description) : undefined,
      entryDate: String(r.entry_date),
      entryNumber: r.entry_number ? String(r.entry_number) : undefined,
      sourceDocumentId: r.source_document_id ? String(r.source_document_id) : undefined,
    }));
    const result = runAutoMatch(bankTxs, glLines);
    let matchedCount = 0;
    for (const match of result.matches) {
      if (match.confidence >= 0.9) {
        await matchTransaction('', match.bankTransactionId, match.journalLineId, reconciliationId);
        matchedCount++;
      }
    }
    const lowConfidence = result.matches.filter(m => m.confidence < 0.9);
    log.info('Auto-match completed', {
      bankAccountId, autoMatched: matchedCount,
      candidates: lowConfidence.length, unmatched: result.unmatched.length,
    }, 'accounting');
    return { matched: matchedCount, unmatched: result.unmatched.length, candidates: lowConfidence };
  } catch (err) {
    log.error('Failed to auto-match transactions', { error: err }, 'accounting');
    throw err;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export async function updateReconciledBalance(reconciliationId: string): Promise<void> {
  const sumRows = (await sql`
    SELECT COALESCE(SUM(amount), 0) AS matched_total FROM bank_transactions
    WHERE reconciliation_id = ${reconciliationId}::UUID AND status IN ('matched', 'reconciled')`) as Row[];
  const reconRows = (await sql`
    SELECT gl_balance FROM bank_reconciliations WHERE id = ${reconciliationId}::UUID`) as Row[];
  if (reconRows.length > 0) {
    const reconciledBalance = Number(reconRows[0]!.gl_balance) + Number(sumRows[0]!.matched_total);
    await sql`UPDATE bank_reconciliations SET reconciled_balance = ${reconciledBalance}
      WHERE id = ${reconciliationId}::UUID`;
  }
}

function mapReconRow(row: Row): BankReconciliation {
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
