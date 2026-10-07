/**
 * PRD-060: FibreFlow Accounting Module — Phase 4
 * Bank Reconciliation Service — reconciliation CRUD, allocation, and auto-match
 */

import { sql, withTransaction } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { log } from '@/lib/logger';
import { createJournalEntry, postJournalEntry } from '../gl/journalEntryService';
import type { BankReconciliation } from '../../types/bank.types';
import type { JournalLineInput } from '../../types/gl.types';
import type { DbRow } from '@/types/db';
import { isBankSubtype } from '../gl/accountSubtypes';
import {
  claimTransactionsForReconciliation, countsAsMatched, countsAsUnmatched,
  type ReconciliationClaim,
} from './bankReconciliationClaim';
import { lockSessionForHeaderChange, refuseCompletedSession, shareLockSession } from './reconciliationSessionLock';
import { bankGlBalanceAsAt, refreshReconciledBalanceIfFree, updateReconciledBalance } from './bankReconciliationBalance';
import { RowLockTimeoutError } from '../core/rowLockBudget';
import { newManualJournalRefusal } from '../gl/manualJournalApproval';


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
            ${sessionCounts(companyId)}
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
            ${sessionCounts(companyId)}
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
        ${sessionCounts(companyId)}
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
): Promise<BankReconciliation & ReconciliationClaim> {
  try {
    const balRows = (await bankGlBalanceAsAt(
      companyId, sql`${bankAccountId}::UUID`, sql`${statementDate}`)) as DbRow[];
    const glBalance = Number(balRows[0]!.gl_balance);

    // INSERT and the subsequent bank_transactions UPDATE must be atomic.
    // If the UPDATE fails after the INSERT, transactions would be orphaned
    // with no reconciliation_id and would be silently skipped in future runs.
    const { recon, claim } = await withTransaction(async (tx) => {
      const rows = (await tx`
        INSERT INTO bank_reconciliations (
          company_id, bank_account_id, statement_date, statement_balance, gl_balance,
          reconciled_balance, started_by
        ) VALUES (
          ${companyId}, ${bankAccountId}::UUID, ${statementDate}, ${statementBalance},
          ${glBalance}, ${glBalance}, ${userId}::UUID
        ) RETURNING *`) as DbRow[];
      // BL-82: company-scoped. Claims unallocated lines AND allocated lines,
      // which are matched to their own journal line — bankReconciliationClaim.
      const claimed = await claimTransactionsForReconciliation(
        tx, companyId, String(rows[0]!.id), bankAccountId, statementDate);
      return { recon: rows[0]!, claim: claimed };
    });
    log.info('Started bank reconciliation', {
      id: String(recon.id), bankAccountId, statementBalance, glBalance, ...claim,
    }, 'accounting');
    return { ...mapReconRow({ ...recon, matched_count: claim.selfMatched,
      unmatched_count: claim.claimedUnallocated }), ...claim };
  } catch (err) {
    log.error('Failed to start reconciliation', { error: err }, 'accounting');
    throw err;
  }
}

export async function completeReconciliation(
  companyId: string, id: string, userId: string
): Promise<BankReconciliation> {
  try {
    // D12: the header FOR UPDATE first (every line writer holds it FOR SHARE): status and figures are read under it.
    const session = await lockSessionForHeaderChange(companyId, id);
    if (!session) throw new Error(`Reconciliation ${id} not found`);
    refuseCompletedSession(session);
    // Sign off against the ledger as it stands NOW, not the start snapshot: a
    // line reversed or a journal back-dated mid-session moves the GL, and the
    // snapshot would let a stale R0.00 through.
    await updateReconciledBalance(companyId, id);
    const recon = await getReconciliationById(companyId, id);
    if (!recon) throw new Error(`Reconciliation ${id} not found`);
    if (Math.abs(recon.difference) > 0.01) {
      throw new Error(`Cannot complete: difference is R${recon.difference.toFixed(2)} (must be R0.00)`);
    }
    // Both UPDATEs must be atomic: if the reconciliation header update fails
    // after transactions are marked 'reconciled', they become stuck in a
    // terminal state with no completed reconciliation to reference them.
    const completedRow = await withTransaction(async (tx) => {
      // BL-83: company_id guard. Reconciles exactly what the session counts as
      // matched — matched lines and self-matched allocated lines.
      await tx`
        UPDATE bank_transactions bt SET status = 'reconciled', updated_at = NOW()
        FROM bank_reconciliations br
        WHERE bt.reconciliation_id = ${id}::UUID AND bt.company_id = ${companyId}::UUID
          AND br.id = bt.reconciliation_id AND br.company_id = ${companyId}::UUID
          AND bt.feed_state = 'posted'
          AND ${countsAsMatched(companyId, sql`br.statement_date`)}`;
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
    // A completed reconciliation is an audit artefact: its balances record what
    // the ledger said at sign-off and must not be rewritten by a later adjustment (D12: under the header lock).
    // D12 round 2: FOR SHARE, not FOR UPDATE — this posts a journal (see reconciliationSessionLock's header).
    refuseCompletedSession(await shareLockSession(companyId, reconciliationId));
    const recon = await getReconciliationById(companyId, reconciliationId);
    if (!recon) throw new Error(`Reconciliation ${reconciliationId} not found`);
    // updateReconciledBalance recomputes from the reconciliation's OWN bank
    // account, so an adjustment posted to a different one would post a journal
    // and silently leave the difference untouched.
    if (bankAccountId !== recon.bankAccountId) {
      throw new Error('Adjustment bank account does not match the reconciliation');
    }
    // R-035 PR6 (Hein, 2026-10-07, H1): a person names the contra account and
    // the amount — a manual journal — and nobody decides the request it would
    // need, so under enforcement a matching rule refuses it HERE, before the
    // journal exists (the route's 409; nothing written), with the way out.
    const refusal = await newManualJournalRefusal(companyId, amount, (role, rule, amountText) =>
      `A bank reconciliation adjustment of ${amountText} is a manual journal, and it needs ${role} approval before it can `
      + `be posted (rule: ${rule}). Post it as a journal through Journal Entries, have it approved, then reconcile it.`);
    if (refusal) throw refusal;
    const je = await createJournalEntry(companyId, {
      entryDate: recon.statementDate,
      description: `Bank recon adjustment: ${description}`,
      // source_record_id, NOT source_document_id: the latter FKs to
      // captured_documents (migration 409) and a reconciliation id throws on it.
      source: 'auto_bank_recon', sourceRecordId: reconciliationId, lines,
    }, userId).catch((err: unknown) => {
      // D12 round 2: no longer the 40P01 victim of a writer sharing the session, the adjustment can lose the
      // pre-existing journal-number race to it (MAX+1, uq_gl_je_company_entry_number) — retryable, nothing written
      // (the 23505 aborted the request): 503 + Retry-After, not a 400 naming the constraint.
      throw isJournalNumberCollision(err) ? new RowLockTimeoutError('The next journal number') : err;
    });
    await postJournalEntry(companyId, je.id, userId);
    await refreshReconciledBalanceIfFree(companyId, reconciliationId);
    log.info('Created adjustment entry', { reconciliationId, journalEntryId: je.id }, 'accounting');
    return je.id;
  } catch (err) {
    log.error('Failed to create adjustment entry', { error: err }, 'accounting');
    throw err;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isJournalNumberCollision(err: unknown): boolean {
  const e = err as { code?: unknown; constraint?: unknown } | null;
  return e?.code === '23505' && e?.constraint === 'uq_gl_je_company_entry_number';
}

/**
 * matched_count / unmatched_count for the row aliased `br` — the claim module's definition. D12 round 2 (brk-d12 B4):
 * a COMPLETED session's matched count is what it signed off — its `reconciled` lines — so a later write to one of its
 * stale-stamped lines (an allocation keeps the stamp) cannot move it.
 */
function sessionCounts(companyId: string): ReturnType<typeof sql> {
  const inSession = sql`bt.reconciliation_id = br.id AND bt.company_id = ${companyId}::UUID
    AND bt.feed_state = 'posted'`;
  return sql`
    (SELECT COUNT(*) FROM bank_transactions bt WHERE ${inSession}
      AND CASE WHEN br.status = 'completed' THEN bt.status = 'reconciled'
        ELSE ${countsAsMatched(companyId, sql`br.statement_date`)} END) AS matched_count,
    (SELECT COUNT(*) FROM bank_transactions bt WHERE ${inSession}
      AND ${countsAsUnmatched(companyId, sql`br.statement_date`)}) AS unmatched_count`;
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
export { autoMatchTransactions } from './bankAutoMatchService';
export { previewReconciliationClaim } from './bankReconciliationClaim';
export { updateReconciledBalance } from './bankReconciliationBalance';
export type { ReconciliationClaim } from './bankReconciliationClaim';
export {
  allocateTransaction, splitAllocateTransaction, reverseReconciledTransaction,
} from './bankAllocationService';
export type { AllocationType, SplitLine } from './bankAllocationService';
