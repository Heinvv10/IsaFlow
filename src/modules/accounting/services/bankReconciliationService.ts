/**
 * PRD-060: FibreFlow Accounting Module — Phase 4
 * Bank Reconciliation Service
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { detectBankFormat, parseFNBStatement, parseStandardBankStatement, parseNedbankStatement, parseABSAStatement, parseCapitecStatement } from '../utils/bankCsvParsers';
import { parseOfxStatement } from '../utils/bankOfxParser';
import { parseQifStatement } from '../utils/bankQifParser';
import { runAutoMatch } from '../utils/autoMatch';
import { createJournalEntry, postJournalEntry } from './journalEntryService';
import type { BankTransaction, BankReconciliation, AutoMatchResult, BankFormat, BankCsvParseResult } from '../types/bank.types';
import type { JournalLineInput } from '../types/gl.types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

// ── Import ───────────────────────────────────────────────────────────────────

export async function importBankStatement(
  _companyId: string,
  csvContent: string,
  bankAccountId: string,
  statementDate: string,
  bankFormat?: BankFormat
): Promise<{ batchId: string; transactionCount: number; errors: Array<{ row: number; error: string }> }> {
  try {
    const format = bankFormat && bankFormat !== 'unknown' ? bankFormat : detectBankFormat(csvContent);
    let parseResult;

    switch (format) {
      case 'fnb':
        parseResult = parseFNBStatement(csvContent);
        break;
      case 'standard_bank':
        parseResult = parseStandardBankStatement(csvContent);
        break;
      case 'nedbank':
        parseResult = parseNedbankStatement(csvContent);
        break;
      case 'absa':
        parseResult = parseABSAStatement(csvContent);
        break;
      case 'capitec':
        parseResult = parseCapitecStatement(csvContent);
        break;
      case 'ofx':
        parseResult = parseOfxStatement(csvContent);
        break;
      case 'qif':
        parseResult = parseQifStatement(csvContent);
        break;
      default:
        throw new Error('Unable to detect bank format. Please specify the bank.');
    }

    if (parseResult.transactions.length === 0) {
      return { batchId: '', transactionCount: 0, errors: parseResult.errors };
    }

    const batchId = crypto.randomUUID();

    for (const tx of parseResult.transactions) {
      await sql`
        INSERT INTO bank_transactions (
          bank_account_id, transaction_date, value_date, amount,
          description, reference, import_batch_id
        ) VALUES (
          ${bankAccountId}::UUID, ${tx.transactionDate}, ${tx.valueDate || null},
          ${tx.amount}, ${tx.description}, ${tx.reference || null}, ${batchId}::UUID
        )
      `;
    }

    log.info('Imported bank statement', {
      batchId, format, count: parseResult.transactions.length,
    }, 'accounting');

    return {
      batchId,
      transactionCount: parseResult.transactions.length,
      errors: parseResult.errors,
    };
  } catch (err) {
    log.error('Failed to import bank statement', { error: err }, 'accounting');
    throw err;
  }
}

// ── Import from Pre-Parsed Result (PDF) ──────────────────────────────────────

/**
 * Persist an already-parsed set of transactions (e.g. from a PDF import).
 * Reuses the same INSERT logic as importBankStatement so behaviour is identical.
 */
export async function importParsedTransactions(
  _companyId: string,
  parseResult: BankCsvParseResult,
  bankAccountId: string,
  statementDate: string,
): Promise<{ batchId: string; transactionCount: number; errors: Array<{ row: number; error: string }> }> {
  try {
    if (parseResult.transactions.length === 0) {
      return { batchId: '', transactionCount: 0, errors: parseResult.errors };
    }

    const batchId = crypto.randomUUID();

    for (const tx of parseResult.transactions) {
      await sql`
        INSERT INTO bank_transactions (
          bank_account_id, transaction_date, value_date, amount,
          description, reference, import_batch_id
        ) VALUES (
          ${bankAccountId}::UUID, ${tx.transactionDate}, ${tx.valueDate || null},
          ${tx.amount}, ${tx.description}, ${tx.reference || null}, ${batchId}::UUID
        )
      `;
    }

    log.info('Imported parsed bank statement', {
      batchId,
      format: parseResult.bankFormat,
      count: parseResult.transactions.length,
      statementDate,
    }, 'accounting');

    return {
      batchId,
      transactionCount: parseResult.transactions.length,
      errors: parseResult.errors,
    };
  } catch (err) {
    log.error('Failed to import parsed bank transactions', { error: err }, 'accounting');
    throw err;
  }
}

// ── Bank Transactions ────────────────────────────────────────────────────────

interface BankTxFilters {
  bankAccountId?: string;
  reconciliationId?: string;
  status?: string;
  fromDate?: string;
  toDate?: string;
  /** Minimum transaction amount (inclusive). Defaults to unbounded when absent. */
  fromAmount?: string;
  /** Maximum transaction amount (inclusive). Defaults to unbounded when absent. */
  toAmount?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export async function getBankTransactions(_companyId: string, filters?: BankTxFilters): Promise<{
  transactions: BankTransaction[];
  total: number;
}> {
  try {
    const limit = filters?.limit || 100;
    const offset = filters?.offset || 0;
    let rows: Row[];
    let countRows: Row[];

    if (filters?.reconciliationId) {
      rows = (await sql`
        SELECT bt.*, ga.account_name AS bank_account_name,
               ga2.account_name AS suggested_gl_account_name,
               ga2.account_code AS suggested_gl_account_code,
               COALESCE(s2.name, s2.company_name) AS suggested_supplier_name,
               c2.company_name AS suggested_client_name,
               cc1.name AS cc1_name, cc2t.name AS cc2_name, dept.name AS bu_name
        FROM bank_transactions bt
        LEFT JOIN gl_accounts ga ON ga.id = bt.bank_account_id
        LEFT JOIN gl_accounts ga2 ON ga2.id = bt.suggested_gl_account_id
        LEFT JOIN suppliers s2 ON s2.id = bt.suggested_supplier_id
        LEFT JOIN clients c2 ON c2.id = bt.suggested_client_id
        LEFT JOIN cost_centres cc1 ON cc1.id = bt.cc1_id
        LEFT JOIN cost_centres cc2t ON cc2t.id = bt.cc2_id
        LEFT JOIN departments dept ON dept.id = bt.bu_id
        WHERE bt.reconciliation_id = ${filters.reconciliationId}::UUID
        ORDER BY bt.transaction_date DESC, bt.amount DESC
        LIMIT ${limit} OFFSET ${offset}
      `) as Row[];
      countRows = (await sql`
        SELECT COUNT(*) AS cnt FROM bank_transactions
        WHERE reconciliation_id = ${filters.reconciliationId}::UUID
      `) as Row[];
    } else if (filters?.bankAccountId && filters?.status) {
      // 🟢 WORKING: date range + amount range + full-text search via always-present params (no conditional SQL fragments)
      const searchPattern = filters.search ? `%${filters.search}%` : '%';
      const fromDateVal = filters.fromDate || '1900-01-01';
      const toDateVal = filters.toDate || '2099-12-31';
      const fromAmountVal = filters.fromAmount || '-999999999';
      const toAmountVal = filters.toAmount || '999999999';
      // 'imported' tab shows both imported and allocated (not-yet-reviewed) transactions
      const statusArr = filters.status === 'imported'
        ? ['imported', 'allocated']
        : [filters.status];
      rows = (await sql`
        SELECT bt.*, ga.account_name AS bank_account_name,
               ga2.account_name AS suggested_gl_account_name,
               ga2.account_code AS suggested_gl_account_code,
               COALESCE(s2.name, s2.company_name) AS suggested_supplier_name,
               c2.company_name AS suggested_client_name,
               cc1.name AS cc1_name, cc2t.name AS cc2_name, dept.name AS bu_name
        FROM bank_transactions bt
        LEFT JOIN gl_accounts ga ON ga.id = bt.bank_account_id
        LEFT JOIN gl_accounts ga2 ON ga2.id = bt.suggested_gl_account_id
        LEFT JOIN suppliers s2 ON s2.id = bt.suggested_supplier_id
        LEFT JOIN clients c2 ON c2.id = bt.suggested_client_id
        LEFT JOIN cost_centres cc1 ON cc1.id = bt.cc1_id
        LEFT JOIN cost_centres cc2t ON cc2t.id = bt.cc2_id
        LEFT JOIN departments dept ON dept.id = bt.bu_id
        WHERE bt.bank_account_id = ${filters.bankAccountId}::UUID
          AND bt.status = ANY(${statusArr}::TEXT[])
          AND bt.transaction_date >= ${fromDateVal}
          AND bt.transaction_date <= ${toDateVal}
          AND bt.amount >= ${fromAmountVal}::NUMERIC
          AND bt.amount <= ${toAmountVal}::NUMERIC
          AND (bt.description ILIKE ${searchPattern} OR bt.reference ILIKE ${searchPattern})
        ORDER BY bt.transaction_date DESC, bt.amount DESC
        LIMIT ${limit} OFFSET ${offset}
      `) as Row[];
      countRows = (await sql`
        SELECT COUNT(*) AS cnt FROM bank_transactions bt
        WHERE bt.bank_account_id = ${filters.bankAccountId}::UUID
          AND bt.status = ANY(${statusArr}::TEXT[])
          AND bt.transaction_date >= ${fromDateVal}
          AND bt.transaction_date <= ${toDateVal}
          AND bt.amount >= ${fromAmountVal}::NUMERIC
          AND bt.amount <= ${toAmountVal}::NUMERIC
          AND (bt.description ILIKE ${searchPattern} OR bt.reference ILIKE ${searchPattern})
      `) as Row[];
    } else if (filters?.bankAccountId) {
      rows = (await sql`
        SELECT bt.*, ga.account_name AS bank_account_name,
               ga2.account_name AS suggested_gl_account_name,
               ga2.account_code AS suggested_gl_account_code,
               COALESCE(s2.name, s2.company_name) AS suggested_supplier_name,
               c2.company_name AS suggested_client_name,
               cc1.name AS cc1_name, cc2t.name AS cc2_name, dept.name AS bu_name
        FROM bank_transactions bt
        LEFT JOIN gl_accounts ga ON ga.id = bt.bank_account_id
        LEFT JOIN gl_accounts ga2 ON ga2.id = bt.suggested_gl_account_id
        LEFT JOIN suppliers s2 ON s2.id = bt.suggested_supplier_id
        LEFT JOIN clients c2 ON c2.id = bt.suggested_client_id
        LEFT JOIN cost_centres cc1 ON cc1.id = bt.cc1_id
        LEFT JOIN cost_centres cc2t ON cc2t.id = bt.cc2_id
        LEFT JOIN departments dept ON dept.id = bt.bu_id
        WHERE bt.bank_account_id = ${filters.bankAccountId}::UUID
        ORDER BY bt.transaction_date DESC, bt.amount DESC
        LIMIT ${limit} OFFSET ${offset}
      `) as Row[];
      countRows = (await sql`
        SELECT COUNT(*) AS cnt FROM bank_transactions
        WHERE bank_account_id = ${filters.bankAccountId}::UUID
      `) as Row[];
    } else {
      rows = (await sql`
        SELECT bt.*, ga.account_name AS bank_account_name,
               ga2.account_name AS suggested_gl_account_name,
               ga2.account_code AS suggested_gl_account_code,
               COALESCE(s2.name, s2.company_name) AS suggested_supplier_name,
               c2.company_name AS suggested_client_name,
               cc1.name AS cc1_name, cc2t.name AS cc2_name, dept.name AS bu_name
        FROM bank_transactions bt
        LEFT JOIN gl_accounts ga ON ga.id = bt.bank_account_id
        LEFT JOIN gl_accounts ga2 ON ga2.id = bt.suggested_gl_account_id
        LEFT JOIN suppliers s2 ON s2.id = bt.suggested_supplier_id
        LEFT JOIN clients c2 ON c2.id = bt.suggested_client_id
        LEFT JOIN cost_centres cc1 ON cc1.id = bt.cc1_id
        LEFT JOIN cost_centres cc2t ON cc2t.id = bt.cc2_id
        LEFT JOIN departments dept ON dept.id = bt.bu_id
        ORDER BY bt.transaction_date DESC, bt.amount DESC
        LIMIT ${limit} OFFSET ${offset}
      `) as Row[];
      countRows = (await sql`SELECT COUNT(*) AS cnt FROM bank_transactions`) as Row[];
    }

    return { transactions: rows.map(mapTxRow), total: Number(countRows[0]!.cnt) };
  } catch (err) {
    log.error('Failed to get bank transactions', { error: err }, 'accounting');
    throw err;
  }
}

// ── Match / Unmatch ──────────────────────────────────────────────────────────

export async function matchTransaction(_companyId: string, 
  bankTxId: string,
  journalLineId: string,
  reconciliationId?: string
): Promise<BankTransaction> {
  try {
    let rows: Row[];
    if (reconciliationId) {
      rows = (await sql`
        UPDATE bank_transactions
        SET status = 'matched',
            matched_journal_line_id = ${journalLineId}::UUID,
            reconciliation_id = ${reconciliationId}::UUID
        WHERE id = ${bankTxId}::UUID
        RETURNING *
      `) as Row[];
    } else {
      rows = (await sql`
        UPDATE bank_transactions
        SET status = 'matched',
            matched_journal_line_id = ${journalLineId}::UUID
        WHERE id = ${bankTxId}::UUID
        RETURNING *
      `) as Row[];
    }

    if (rows.length === 0) throw new Error(`Bank transaction ${bankTxId} not found`);

    // Update reconciled balance if part of a reconciliation
    if (reconciliationId) {
      await updateReconciledBalance(reconciliationId);
    }

    log.info('Matched bank transaction', { bankTxId, journalLineId }, 'accounting');
    return mapTxRow(rows[0]!);
  } catch (err) {
    log.error('Failed to match bank transaction', { bankTxId, error: err }, 'accounting');
    throw err;
  }
}

export async function unmatchTransaction(_companyId: string, bankTxId: string): Promise<BankTransaction> {
  try {
    const existing = (await sql`SELECT reconciliation_id FROM bank_transactions WHERE id = ${bankTxId}::UUID`) as Row[];
    const reconId = existing[0]?.reconciliation_id ? String(existing[0].reconciliation_id) : null;

    const rows = (await sql`
      UPDATE bank_transactions
      SET status = 'imported',
          matched_journal_line_id = NULL,
          allocation_type = NULL,
          allocated_entity_name = NULL
      WHERE id = ${bankTxId}::UUID
      RETURNING *
    `) as Row[];

    if (rows.length === 0) throw new Error(`Bank transaction ${bankTxId} not found`);

    if (reconId) {
      await updateReconciledBalance(reconId);
    }

    log.info('Unmatched bank transaction', { bankTxId }, 'accounting');
    return mapTxRow(rows[0]!);
  } catch (err) {
    log.error('Failed to unmatch bank transaction', { bankTxId, error: err }, 'accounting');
    throw err;
  }
}

export async function excludeTransaction(_companyId: string, bankTxId: string, reason?: string): Promise<BankTransaction> {
  try {
    const rows = (await sql`
      UPDATE bank_transactions
      SET status = 'excluded', exclude_reason = ${reason || null}
      WHERE id = ${bankTxId}::UUID
      RETURNING *
    `) as Row[];
    if (rows.length === 0) throw new Error(`Bank transaction ${bankTxId} not found`);
    log.info('Excluded bank transaction', { bankTxId, reason }, 'accounting');
    return mapTxRow(rows[0]!);
  } catch (err) {
    log.error('Failed to exclude bank transaction', { bankTxId, error: err }, 'accounting');
    throw err;
  }
}

// ── Delete ───────────────────────────────────────────────────────────────────

/**
 * Delete bank transactions — only imported (unallocated) transactions can be deleted.
 * Matched/reconciled transactions must be unmatched first.
 */
export async function deleteTransactions(_companyId: string, bankTxIds: string[]): Promise<number> {
  if (bankTxIds.length === 0) return 0;
  try {
    const result = (await sql`
      DELETE FROM bank_transactions
      WHERE id = ANY(${bankTxIds}::UUID[])
        AND status = 'imported'
    `) as Row[];
    const deleted = result.length ?? bankTxIds.length;
    log.info('Deleted bank transactions', { count: deleted, ids: bankTxIds }, 'accounting');
    return deleted;
  } catch (err) {
    log.error('Failed to delete bank transactions', { bankTxIds, error: err }, 'accounting');
    throw err;
  }
}

// ── Bulk Accept ──────────────────────────────────────────────────────────────

/**
 * Mark a batch of imported transactions as 'matched' without creating journal entries.
 * Used for the Bulk Accept toolbar action — accepts transactions that don't need GL allocation.
 */
export async function bulkAcceptTransactions(_companyId: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  try {
    // Move both imported (unallocated) and allocated transactions to reviewed
    const result = (await sql`
      UPDATE bank_transactions SET status = 'matched', updated_at = NOW()
      WHERE id = ANY(${ids}::UUID[]) AND status IN ('imported', 'allocated')
    `) as Row[];
    const count = (result as unknown as { count?: number }).count ?? ids.length;
    log.info('Bulk accepted bank transactions', { count, ids }, 'accounting');
    return count;
  } catch (err) {
    log.error('Failed to bulk accept bank transactions', { ids, error: err }, 'accounting');
    throw err;
  }
}

// ── Auto-Match ───────────────────────────────────────────────────────────────

export async function autoMatchTransactions(_companyId: string, 
  bankAccountId: string,
  reconciliationId?: string
): Promise<AutoMatchResult> {
  try {
    // Get unmatched bank transactions
    const bankTxRows = (await sql`
      SELECT id, amount, transaction_date, reference, description
      FROM bank_transactions
      WHERE bank_account_id = ${bankAccountId}::UUID AND status = 'imported'
      ORDER BY transaction_date
    `) as Row[];

    if (bankTxRows.length === 0) {
      return { matched: 0, unmatched: 0, candidates: [] };
    }

    // Get unmatched GL journal lines for this bank account (posted entries only)
    const glRows = (await sql`
      SELECT jl.id, jl.debit, jl.credit, jl.description,
        je.entry_date, je.entry_number, je.source_document_id
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      WHERE jl.gl_account_id = ${bankAccountId}::UUID
        AND je.status = 'posted'
        AND jl.id NOT IN (
          SELECT matched_journal_line_id FROM bank_transactions
          WHERE matched_journal_line_id IS NOT NULL
        )
      ORDER BY je.entry_date
    `) as Row[];

    const bankTxs = bankTxRows.map((r: Row) => ({
      id: String(r.id),
      amount: Number(r.amount),
      transactionDate: String(r.transaction_date),
      reference: r.reference ? String(r.reference) : undefined,
      description: r.description ? String(r.description) : undefined,
    }));

    const glLines = glRows.map((r: Row) => ({
      id: String(r.id),
      debit: Number(r.debit),
      credit: Number(r.credit),
      description: r.description ? String(r.description) : undefined,
      entryDate: String(r.entry_date),
      entryNumber: r.entry_number ? String(r.entry_number) : undefined,
      sourceDocumentId: r.source_document_id ? String(r.source_document_id) : undefined,
    }));

    const result = runAutoMatch(bankTxs, glLines);

    // Apply high-confidence matches automatically (>= 0.9)
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

    return {
      matched: matchedCount,
      unmatched: result.unmatched.length,
      candidates: lowConfidence,
    };
  } catch (err) {
    log.error('Failed to auto-match transactions', { error: err }, 'accounting');
    throw err;
  }
}

// ── Reconciliation CRUD ──────────────────────────────────────────────────────

export async function getReconciliations(_companyId: string, bankAccountId?: string): Promise<BankReconciliation[]> {
  try {
    let rows: Row[];
    if (bankAccountId) {
      rows = (await sql`
        SELECT br.*, ga.account_name AS bank_account_name,
          (SELECT COUNT(*) FROM bank_transactions WHERE reconciliation_id = br.id AND status = 'matched') AS matched_count,
          (SELECT COUNT(*) FROM bank_transactions WHERE reconciliation_id = br.id AND status = 'imported') AS unmatched_count
        FROM bank_reconciliations br
        LEFT JOIN gl_accounts ga ON ga.id = br.bank_account_id
        WHERE br.bank_account_id = ${bankAccountId}::UUID
        ORDER BY br.statement_date DESC
      `) as Row[];
    } else {
      rows = (await sql`
        SELECT br.*, ga.account_name AS bank_account_name,
          (SELECT COUNT(*) FROM bank_transactions WHERE reconciliation_id = br.id AND status = 'matched') AS matched_count,
          (SELECT COUNT(*) FROM bank_transactions WHERE reconciliation_id = br.id AND status = 'imported') AS unmatched_count
        FROM bank_reconciliations br
        LEFT JOIN gl_accounts ga ON ga.id = br.bank_account_id
        ORDER BY br.statement_date DESC
      `) as Row[];
    }
    return rows.map(mapReconRow);
  } catch (err) {
    log.error('Failed to get reconciliations', { error: err }, 'accounting');
    throw err;
  }
}

export async function getReconciliationById(_companyId: string, id: string): Promise<BankReconciliation | null> {
  try {
    const rows = (await sql`
      SELECT br.*, ga.account_name AS bank_account_name,
        (SELECT COUNT(*) FROM bank_transactions WHERE reconciliation_id = br.id AND status = 'matched') AS matched_count,
        (SELECT COUNT(*) FROM bank_transactions WHERE reconciliation_id = br.id AND status = 'imported') AS unmatched_count
      FROM bank_reconciliations br
      LEFT JOIN gl_accounts ga ON ga.id = br.bank_account_id
      WHERE br.id = ${id}::UUID
    `) as Row[];
    return rows.length > 0 ? mapReconRow(rows[0]!) : null;
  } catch (err) {
    log.error('Failed to get reconciliation', { id, error: err }, 'accounting');
    throw err;
  }
}

export async function startReconciliation(
  _companyId: string,
  bankAccountId: string,
  statementDate: string,
  statementBalance: number,
  userId: string
): Promise<BankReconciliation> {
  try {
    // Calculate current GL balance for this bank account
    const balRows = (await sql`
      SELECT COALESCE(SUM(jl.debit) - SUM(jl.credit), 0) AS gl_balance
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      WHERE jl.gl_account_id = ${bankAccountId}::UUID
        AND je.status = 'posted'
        AND je.entry_date <= ${statementDate}
    `) as Row[];

    const glBalance = Number(balRows[0]!.gl_balance);

    const rows = (await sql`
      INSERT INTO bank_reconciliations (
        bank_account_id, statement_date, statement_balance, gl_balance,
        reconciled_balance, started_by
      ) VALUES (
        ${bankAccountId}::UUID, ${statementDate}, ${statementBalance},
        ${glBalance}, ${glBalance}, ${userId}::UUID
      ) RETURNING *
    `) as Row[];

    // Link unmatched imported transactions to this reconciliation
    await sql`
      UPDATE bank_transactions
      SET reconciliation_id = ${rows[0]!.id}::UUID
      WHERE bank_account_id = ${bankAccountId}::UUID
        AND status = 'imported'
        AND reconciliation_id IS NULL
    `;

    log.info('Started bank reconciliation', {
      id: String(rows[0]!.id), bankAccountId, statementBalance, glBalance,
    }, 'accounting');

    return mapReconRow(rows[0]!);
  } catch (err) {
    log.error('Failed to start reconciliation', { error: err }, 'accounting');
    throw err;
  }
}

export async function completeReconciliation(_companyId: string, id: string, userId: string): Promise<BankReconciliation> {
  try {
    const recon = await getReconciliationById(_companyId, id);
    if (!recon) throw new Error(`Reconciliation ${id} not found`);
    if (recon.status === 'completed') throw new Error('Reconciliation already completed');
    if (Math.abs(recon.difference) > 0.01) {
      throw new Error(`Cannot complete: difference is R${recon.difference.toFixed(2)} (must be R0.00)`);
    }

    // Mark all matched transactions as reconciled
    await sql`
      UPDATE bank_transactions SET status = 'reconciled'
      WHERE reconciliation_id = ${id}::UUID AND status = 'matched'
    `;

    const rows = (await sql`
      UPDATE bank_reconciliations
      SET status = 'completed', completed_by = ${userId}::UUID, completed_at = NOW()
      WHERE id = ${id}::UUID RETURNING *
    `) as Row[];

    log.info('Completed bank reconciliation', { id }, 'accounting');
    return mapReconRow(rows[0]!);
  } catch (err) {
    log.error('Failed to complete reconciliation', { id, error: err }, 'accounting');
    throw err;
  }
}

// ── Adjustment Entry ─────────────────────────────────────────────────────────

export async function createAdjustmentEntry(
  _companyId: string,
  reconciliationId: string,
  bankAccountId: string,
  contraAccountId: string,
  amount: number,
  description: string,
  userId: string
): Promise<string> {
  try {
    const lines: JournalLineInput[] = amount > 0
      ? [
          { glAccountId: bankAccountId, debit: amount, credit: 0, description },
          { glAccountId: contraAccountId, debit: 0, credit: amount, description },
        ]
      : [
          { glAccountId: contraAccountId, debit: Math.abs(amount), credit: 0, description },
          { glAccountId: bankAccountId, debit: 0, credit: Math.abs(amount), description },
        ];

    const recon = await getReconciliationById(_companyId, reconciliationId);
    if (!recon) throw new Error(`Reconciliation ${reconciliationId} not found`);

    const je = await createJournalEntry(_companyId, {
      entryDate: recon.statementDate,
      description: `Bank recon adjustment: ${description}`,
      source: 'auto_bank_recon',
      sourceDocumentId: reconciliationId,
      lines,
    }, userId);
    await postJournalEntry('', je.id, userId);

    // Update reconciled balance
    await updateReconciledBalance(reconciliationId);

    log.info('Created adjustment entry', { reconciliationId, journalEntryId: je.id }, 'accounting');
    return je.id;
  } catch (err) {
    log.error('Failed to create adjustment entry', { error: err }, 'accounting');
    throw err;
  }
}

// ── Allocate (Sage-style "Process Bank") ────────────────────────────────────

export type AllocationType = 'account' | 'supplier' | 'customer';

/** Look up a GL account by its code (e.g. '2110' for AP, '1120' for AR) */
async function glAccountByCode(code: string): Promise<string> {
  const rows = (await sql`
    SELECT id FROM gl_accounts WHERE account_code = ${code} AND is_active = TRUE LIMIT 1
  `) as Row[];
  if (rows.length === 0) throw new Error(`GL account ${code} not found`);
  return String(rows[0]!.id);
}

/**
 * Allocate a bank transaction — Sage Process Bank equivalent.
 * Supports three types:
 *   account  → DR/CR bank ↔ GL account
 *   supplier → DR Accounts Payable (2110), CR Bank (payment out)
 *   customer → DR Bank, CR Accounts Receivable (1120) (receipt in)
 */
export async function allocateTransaction(
  _companyId: string,
  bankTxId: string,
  contraAccountId: string,
  userId: string,
  description?: string,
  allocType: AllocationType = 'account',
  entityId?: string,
  vatCode?: string,
  cc1Id?: string,
  cc2Id?: string,
  buId?: string,
): Promise<{ journalEntryId: string; bankTransaction: BankTransaction }> {
  // Get the bank transaction
  const txRows = (await sql`
    SELECT * FROM bank_transactions WHERE id = ${bankTxId}::UUID
  `) as Row[];
  if (txRows.length === 0) throw new Error(`Bank transaction ${bankTxId} not found`);
  const tx = txRows[0]!;

  if (tx.status !== 'imported') {
    throw new Error(`Transaction already ${tx.status} — cannot allocate`);
  }

  const totalAmount = Math.abs(Number(tx.amount));
  const bankAccountId = String(tx.bank_account_id);
  const txDate = tx.transaction_date instanceof Date
    ? tx.transaction_date.toISOString().split('T')[0]
    : String(tx.transaction_date).split('T')[0];
  const isSpent = Number(tx.amount) < 0;

  // VAT splitting: Standard (15%) splits into net + VAT
  const hasVat = vatCode === 'standard';
  const vatRate = hasVat ? 15 : 0;
  const netAmount = hasVat ? Math.round((totalAmount * 100 / 115) * 100) / 100 : totalAmount;
  const vatAmount = hasVat ? Math.round((totalAmount - netAmount) * 100) / 100 : 0;
  // VAT accounts: 1140 VAT Input (expenses/payments), 2120 VAT Output (sales/receipts)
  const vatAccountCode = isSpent ? '1140' : '2120';
  const mapVatType = vatCode === 'standard' ? 'standard' as const
    : vatCode === 'zero_rated' ? 'zero_rated' as const
    : vatCode === 'exempt' ? 'exempt' as const
    : undefined;

  let lines: JournalLineInput[];
  let source: import('../types/gl.types').GLEntrySource;
  let entryDesc: string;
  let allocEntityName: string | null = null;

  if (allocType === 'supplier' && entityId) {
    // Supplier payment: DR Accounts Payable, CR Bank (+ VAT Input if applicable)
    const apAccountId = await glAccountByCode('2110');
    const supRows = (await sql`SELECT name FROM suppliers WHERE id = ${Number(entityId)}`) as Row[];
    const supName = supRows.length > 0 ? String(supRows[0]!.name) : `Supplier #${entityId}`;
    allocEntityName = supName;
    entryDesc = description || `Payment to ${supName}`;
    source = 'auto_supplier_payment';
    lines = [
      { glAccountId: apAccountId, debit: netAmount, credit: 0, description: entryDesc, vatType: mapVatType },
      { glAccountId: bankAccountId, debit: 0, credit: totalAmount, description: entryDesc },
    ];
    if (hasVat) {
      const vatAcctId = await glAccountByCode(vatAccountCode);
      lines.splice(1, 0, { glAccountId: vatAcctId, debit: vatAmount, credit: 0, description: `VAT @ ${vatRate}%`, vatType: 'standard' });
    }
  } else if (allocType === 'customer' && entityId) {
    // Customer receipt: DR Bank, CR Accounts Receivable (+ VAT Output if applicable)
    const arAccountId = await glAccountByCode('1120');
    const custRows = (await sql`SELECT company_name FROM clients WHERE id = ${entityId}::UUID`) as Row[];
    const custName = custRows.length > 0 ? String(custRows[0]!.company_name) : `Customer #${entityId}`;
    allocEntityName = custName;
    entryDesc = description || `Receipt from ${custName}`;
    source = 'auto_payment';
    lines = [
      { glAccountId: bankAccountId, debit: totalAmount, credit: 0, description: entryDesc },
      { glAccountId: arAccountId, debit: 0, credit: netAmount, description: entryDesc, vatType: mapVatType },
    ];
    if (hasVat) {
      const vatAcctId = await glAccountByCode(vatAccountCode);
      lines.push({ glAccountId: vatAcctId, debit: 0, credit: vatAmount, description: `VAT @ ${vatRate}%`, vatType: 'standard' });
    }
  } else {
    // Standard GL account allocation
    const acctRows = (await sql`SELECT account_code, account_name FROM gl_accounts WHERE id = ${contraAccountId}::UUID`) as Row[];
    allocEntityName = acctRows.length > 0 ? `${acctRows[0]!.account_code} ${acctRows[0]!.account_name}` : null;
    entryDesc = description || tx.description || 'Bank allocation';
    source = 'auto_bank_recon';
    if (!isSpent) {
      // Money in: DR Bank (total), CR Contra (net), CR VAT Output (vat)
      lines = [
        { glAccountId: bankAccountId, debit: totalAmount, credit: 0, description: entryDesc },
        { glAccountId: contraAccountId, debit: 0, credit: netAmount, description: entryDesc, vatType: mapVatType },
      ];
      if (hasVat) {
        const vatAcctId = await glAccountByCode(vatAccountCode);
        lines.push({ glAccountId: vatAcctId, debit: 0, credit: vatAmount, description: `VAT @ ${vatRate}%`, vatType: 'standard' });
      }
    } else {
      // Money out: DR Contra (net), DR VAT Input (vat), CR Bank (total)
      lines = [
        { glAccountId: contraAccountId, debit: netAmount, credit: 0, description: entryDesc, vatType: mapVatType },
      ];
      if (hasVat) {
        const vatAcctId = await glAccountByCode(vatAccountCode);
        lines.push({ glAccountId: vatAcctId, debit: vatAmount, credit: 0, description: `VAT @ ${vatRate}%`, vatType: 'standard' });
      }
      lines.push({ glAccountId: bankAccountId, debit: 0, credit: totalAmount, description: entryDesc });
    }
  }

  // Attach CC1 (cost centre) and BU to contra (non-bank) lines
  const linesWithDims = lines.map(l =>
    l.glAccountId === bankAccountId ? l : { ...l, costCenterId: cc1Id || l.costCenterId, buId: buId || l.buId }
  );

  const je = await createJournalEntry(_companyId, {
    entryDate: txDate,
    description: entryDesc,
    source,
    sourceDocumentId: bankTxId,
    lines: linesWithDims,
  }, userId);
  await postJournalEntry('', je.id, userId);

  // Find the bank-side journal line to match against
  const jeLines = (await sql`
    SELECT id FROM gl_journal_lines
    WHERE journal_entry_id = ${je.id}::UUID
      AND gl_account_id = ${bankAccountId}::UUID
    LIMIT 1
  `) as Row[];

  const journalLineId = jeLines.length > 0 ? String(jeLines[0]!.id) : null;

  // Mark as allocated (stays on New tab until explicitly reviewed); persist dimensions
  if (journalLineId) {
    await sql`
      UPDATE bank_transactions
      SET status = 'allocated',
          matched_journal_line_id = ${journalLineId}::UUID,
          allocation_type = ${allocType},
          allocated_entity_name = ${allocEntityName},
          cc1_id = ${cc1Id || null}::UUID,
          cc2_id = ${cc2Id || null}::UUID,
          bu_id = ${buId || null}::UUID,
          updated_at = NOW()
      WHERE id = ${bankTxId}::UUID
    `;
  }

  // Create customer_payments record so payment appears in customer statements
  if (allocType === 'customer' && entityId) {
    await sql`
      INSERT INTO customer_payments (
        client_id, payment_date, total_amount, payment_method,
        bank_reference, bank_account_id, description, status,
        gl_journal_entry_id, created_by, confirmed_by, confirmed_at
      ) VALUES (
        ${entityId}::UUID, ${txDate}, ${totalAmount}, 'eft',
        ${tx.reference || tx.bank_reference || tx.description || null},
        ${bankAccountId}::UUID, ${entryDesc}, 'confirmed',
        ${je.id}::UUID, ${userId}::UUID, ${userId}::UUID, NOW()
      )
    `;
  }

  log.info('Allocated bank transaction', {
    bankTxId, journalEntryId: je.id, allocType, entityId, contraAccountId,
  }, 'accounting');

  const updated = (await sql`SELECT * FROM bank_transactions WHERE id = ${bankTxId}::UUID`) as Row[];
  return { journalEntryId: je.id, bankTransaction: mapTxRow(updated[0]!) };
}

// ── Split Allocate ───────────────────────────────────────────────────────────

export interface SplitLine {
  contraAccountId: string;
  amount: number; // absolute amount for this line
  description?: string;
  vatCode?: string; // 'none' | 'standard' | 'zero_rated' | 'exempt'
}

/**
 * Split-allocate a bank transaction across multiple GL accounts.
 * Each split line may carry its own VAT treatment.
 * The sum of all line amounts must equal Math.abs(tx.amount).
 */
export async function splitAllocateTransaction(_companyId: string, 
  bankTxId: string,
  lines: SplitLine[],
  userId: string,
): Promise<{ journalEntryId: string; bankTransaction: BankTransaction }> {
  const txRows = (await sql`
    SELECT * FROM bank_transactions WHERE id = ${bankTxId}::UUID
  `) as Row[];
  if (txRows.length === 0) throw new Error(`Bank transaction ${bankTxId} not found`);
  const tx = txRows[0]!;

  if (tx.status !== 'imported') {
    throw new Error(`Transaction already ${tx.status} — cannot split allocate`);
  }

  if (!lines || lines.length === 0) throw new Error('At least one split line is required');

  const totalAmount = Math.abs(Number(tx.amount));
  const linesTotal = lines.reduce((sum, l) => sum + Number(l.amount), 0);
  // Allow 1-cent rounding tolerance
  if (Math.abs(linesTotal - totalAmount) > 0.01) {
    throw new Error(
      `Split lines total R${linesTotal.toFixed(2)} does not equal transaction amount R${totalAmount.toFixed(2)}`
    );
  }

  const bankAccountId = String(tx.bank_account_id);
  const txDate = tx.transaction_date instanceof Date
    ? tx.transaction_date.toISOString().split('T')[0]
    : String(tx.transaction_date).split('T')[0];
  const isSpent = Number(tx.amount) < 0;
  const entryDesc = tx.description || 'Split bank allocation';
  const journalLines: JournalLineInput[] = [];

  // Build contra lines for each split
  for (const line of lines) {
    const lineAmount = Number(line.amount);
    const hasVat = line.vatCode === 'standard';
    const netAmount = hasVat ? Math.round((lineAmount * 100 / 115) * 100) / 100 : lineAmount;
    const vatAmount = hasVat ? Math.round((lineAmount - netAmount) * 100) / 100 : 0;
    const vatAccountCode = isSpent ? '1140' : '2120';
    const lineDesc = line.description || entryDesc;
    const mapVatType = line.vatCode === 'standard' ? 'standard' as const
      : line.vatCode === 'zero_rated' ? 'zero_rated' as const
      : line.vatCode === 'exempt' ? 'exempt' as const
      : undefined;

    if (isSpent) {
      // Money out: DR contra (net), DR VAT Input (vat if standard)
      journalLines.push({
        glAccountId: line.contraAccountId,
        debit: netAmount, credit: 0,
        description: lineDesc,
        vatType: mapVatType,
      });
      if (hasVat) {
        const vatAcctId = await glAccountByCode(vatAccountCode);
        journalLines.push({
          glAccountId: vatAcctId,
          debit: vatAmount, credit: 0,
          description: `VAT @ 15%`,
          vatType: 'standard',
        });
      }
    } else {
      // Money in: CR contra (net), CR VAT Output (vat if standard)
      journalLines.push({
        glAccountId: line.contraAccountId,
        debit: 0, credit: netAmount,
        description: lineDesc,
        vatType: mapVatType,
      });
      if (hasVat) {
        const vatAcctId = await glAccountByCode(vatAccountCode);
        journalLines.push({
          glAccountId: vatAcctId,
          debit: 0, credit: vatAmount,
          description: `VAT @ 15%`,
          vatType: 'standard',
        });
      }
    }
  }

  // Add the bank side as a single balancing line
  if (isSpent) {
    journalLines.push({ glAccountId: bankAccountId, debit: 0, credit: totalAmount, description: entryDesc });
  } else {
    journalLines.unshift({ glAccountId: bankAccountId, debit: totalAmount, credit: 0, description: entryDesc });
  }

  const je = await createJournalEntry(_companyId, {
    entryDate: txDate,
    description: entryDesc,
    source: 'auto_bank_recon',
    sourceDocumentId: bankTxId,
    lines: journalLines,
  }, userId);
  await postJournalEntry('', je.id, userId);

  // Find the bank-side journal line to match against
  const jeLines = (await sql`
    SELECT id FROM gl_journal_lines
    WHERE journal_entry_id = ${je.id}::UUID
      AND gl_account_id = ${bankAccountId}::UUID
    LIMIT 1
  `) as Row[];
  const journalLineId = jeLines.length > 0 ? String(jeLines[0]!.id) : null;

  if (journalLineId) {
    await sql`
      UPDATE bank_transactions
      SET status = 'allocated',
          matched_journal_line_id = ${journalLineId}::UUID,
          allocation_type = 'account',
          allocated_entity_name = 'Split allocation',
          updated_at = NOW()
      WHERE id = ${bankTxId}::UUID
    `;
  }

  log.info('Split-allocated bank transaction', {
    bankTxId, journalEntryId: je.id, lineCount: lines.length,
  }, 'accounting');

  const updated = (await sql`SELECT * FROM bank_transactions WHERE id = ${bankTxId}::UUID`) as Row[];
  return { journalEntryId: je.id, bankTransaction: mapTxRow(updated[0]!) };
}

// ── Reverse Reconciled ───────────────────────────────────────────────────────

/**
 * Reverse a matched or reconciled bank transaction.
 * - If a journal entry was created, it is reversed via reverseJournalEntry.
 * - The bank transaction is reset to 'imported' with all links cleared.
 */
export async function reverseReconciledTransaction(_companyId: string, bankTxId: string, userId: string): Promise<void> {
  // 1. Fetch the bank transaction
  const txRows = (await sql`
    SELECT * FROM bank_transactions WHERE id = ${bankTxId}::UUID
  `) as Row[];
  const tx = txRows[0];
  if (!tx) throw new Error('Transaction not found');
  if (tx.status !== 'allocated' && tx.status !== 'matched' && tx.status !== 'reconciled') {
    throw new Error('Can only reverse allocated, matched, or reconciled transactions');
  }

  // 2. If there is a matched journal line, reverse the parent journal entry
  if (tx.matched_journal_line_id) {
    const jlRows = (await sql`
      SELECT journal_entry_id FROM gl_journal_lines WHERE id = ${tx.matched_journal_line_id}::UUID
    `) as Row[];
    if (jlRows.length > 0 && jlRows[0]!.journal_entry_id) {
      const { reverseJournalEntry } = await import('./journalEntryService');
      try {
        await reverseJournalEntry('', String(jlRows[0]!.journal_entry_id), userId);
      } catch (e) {
        throw new Error(`Cannot reverse: ${e instanceof Error ? e.message : 'Journal reversal failed'}`);
      }
    }
  }

  // 3. Reset bank transaction to imported and clear all link fields
  await sql`
    UPDATE bank_transactions
    SET status = 'imported',
        matched_journal_line_id = NULL,
        reconciliation_id = NULL,
        linked_po_id = NULL,
        linked_asset_id = NULL,
        linked_fleet_fuel_id = NULL,
        linked_fleet_service_id = NULL,
        allocation_type = NULL,
        allocated_entity_name = NULL,
        updated_at = NOW()
    WHERE id = ${bankTxId}::UUID
  `;

  log.info('Reversed reconciled bank transaction', { bankTxId, userId }, 'accounting');
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function updateReconciledBalance(reconciliationId: string): Promise<void> {
  // Reconciled balance = sum of matched bank transaction amounts
  const sumRows = (await sql`
    SELECT COALESCE(SUM(amount), 0) AS matched_total
    FROM bank_transactions
    WHERE reconciliation_id = ${reconciliationId}::UUID
      AND status IN ('matched', 'reconciled')
  `) as Row[];

  const reconRows = (await sql`
    SELECT gl_balance FROM bank_reconciliations WHERE id = ${reconciliationId}::UUID
  `) as Row[];

  if (reconRows.length > 0) {
    const reconciledBalance = Number(reconRows[0]!.gl_balance) + Number(sumRows[0]!.matched_total);
    await sql`
      UPDATE bank_reconciliations SET reconciled_balance = ${reconciledBalance}
      WHERE id = ${reconciliationId}::UUID
    `;
  }
}

function fmtDate(val: unknown): string {
  if (val instanceof Date) return val.toISOString().split('T')[0] ?? '';
  return val ? String(val).split('T')[0] ?? '' : '';
}

function mapTxRow(row: Row): BankTransaction {
  return {
    id: String(row.id),
    bankAccountId: String(row.bank_account_id),
    transactionDate: fmtDate(row.transaction_date),
    valueDate: row.value_date ? fmtDate(row.value_date) : undefined,
    amount: Number(row.amount),
    description: row.description ? String(row.description) : undefined,
    reference: row.reference ? String(row.reference) : undefined,
    bankReference: row.bank_reference ? String(row.bank_reference) : undefined,
    status: String(row.status) as BankTransaction['status'],
    matchedJournalLineId: row.matched_journal_line_id ? String(row.matched_journal_line_id) : undefined,
    reconciliationId: row.reconciliation_id ? String(row.reconciliation_id) : undefined,
    importBatchId: row.import_batch_id ? String(row.import_batch_id) : undefined,
    excludeReason: row.exclude_reason ? String(row.exclude_reason) : undefined,
    notes: row.notes ? String(row.notes) : undefined,
    suggestedGlAccountId: row.suggested_gl_account_id ? String(row.suggested_gl_account_id) : undefined,
    suggestedCategory: row.suggested_category ? String(row.suggested_category) : undefined,
    suggestedCostCentre: row.suggested_cost_centre ? String(row.suggested_cost_centre) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    bankAccountName: row.bank_account_name ? String(row.bank_account_name) : undefined,
    matchedEntryNumber: row.matched_entry_number ? String(row.matched_entry_number) : undefined,
    suggestedGlAccountName: row.suggested_gl_account_name ? String(row.suggested_gl_account_name) : undefined,
    suggestedGlAccountCode: row.suggested_gl_account_code ? String(row.suggested_gl_account_code) : undefined,
    suggestedSupplierId: row.suggested_supplier_id ? String(row.suggested_supplier_id) : undefined,
    suggestedSupplierName: row.suggested_supplier_name ? String(row.suggested_supplier_name) : undefined,
    suggestedClientId: row.suggested_client_id ? String(row.suggested_client_id) : undefined,
    suggestedClientName: row.suggested_client_name ? String(row.suggested_client_name) : undefined,
    suggestedVatCode: row.suggested_vat_code && row.suggested_vat_code !== 'none' ? String(row.suggested_vat_code) : undefined,
    suggestedConfidence: row.suggested_confidence != null ? Number(row.suggested_confidence) : undefined,
    cc1Id: row.cc1_id ? String(row.cc1_id) : undefined,
    cc2Id: row.cc2_id ? String(row.cc2_id) : undefined,
    buId: row.bu_id ? String(row.bu_id) : undefined,
    cc1Name: row.cc1_name ? String(row.cc1_name) : undefined,
    cc2Name: row.cc2_name ? String(row.cc2_name) : undefined,
    buName: row.bu_name ? String(row.bu_name) : undefined,
    allocationType: row.allocation_type ? String(row.allocation_type) as BankTransaction['allocationType'] : undefined,
    allocatedEntityName: row.allocated_entity_name ? String(row.allocated_entity_name) : undefined,
  };
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
