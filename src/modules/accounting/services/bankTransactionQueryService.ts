/**
 * PRD-060: FibreFlow Accounting Module — Phase 4
 * Bank Transaction Query Service — queries, status mutations, and row mappers
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { BankTransaction } from '../types/bank.types';

type Row = Record<string, unknown>;

// ── Row Mappers ───────────────────────────────────────────────────────────────

export function fmtDate(val: unknown): string {
  if (val instanceof Date) return val.toISOString().split('T')[0] ?? '';
  return val ? String(val).split('T')[0] ?? '' : '';
}

export function mapTxRow(row: Row): BankTransaction {
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
    suggestedVatCode: row.suggested_vat_code && row.suggested_vat_code !== 'none'
      ? String(row.suggested_vat_code) : undefined,
    suggestedConfidence: row.suggested_confidence != null ? Number(row.suggested_confidence) : undefined,
    cc1Id: row.cc1_id ? String(row.cc1_id) : undefined,
    cc2Id: row.cc2_id ? String(row.cc2_id) : undefined,
    buId: row.bu_id ? String(row.bu_id) : undefined,
    cc1Name: row.cc1_name ? String(row.cc1_name) : undefined,
    cc2Name: row.cc2_name ? String(row.cc2_name) : undefined,
    buName: row.bu_name ? String(row.bu_name) : undefined,
    allocationType: row.allocation_type
      ? String(row.allocation_type) as BankTransaction['allocationType'] : undefined,
    allocatedEntityName: row.allocated_entity_name ? String(row.allocated_entity_name) : undefined,
  };
}

// ── Filters Interface ─────────────────────────────────────────────────────────

export interface BankTxFilters {
  bankAccountId?: string;
  reconciliationId?: string;
  status?: string;
  fromDate?: string;
  toDate?: string;
  fromAmount?: string;
  toAmount?: string;
  search?: string;
  sortOrder?: 'asc' | 'desc';
  allocationFilter?: 'all' | 'unallocated' | 'allocated';
  txType?: 'all' | 'spent' | 'received';
  allocType?: 'all' | 'account' | 'supplier' | 'customer';
  hasSuggestion?: 'all' | 'yes' | 'no';
  limit?: number;
  offset?: number;
}

// ── Shared SELECT fragment ────────────────────────────────────────────────────

const TX_SELECT = sql`
  SELECT bt.*, ga.account_name AS bank_account_name,
         sga.account_name AS suggested_gl_account_name, sga.account_code AS suggested_gl_account_code,
         COALESCE(ss.company_name, ss.name) AS suggested_supplier_name,
         sc.name AS suggested_client_name
  FROM bank_transactions bt
  LEFT JOIN gl_accounts ga ON ga.id = bt.bank_account_id
  LEFT JOIN gl_accounts sga ON sga.id = bt.suggested_gl_account_id
  LEFT JOIN suppliers ss ON ss.id = bt.suggested_supplier_id
  LEFT JOIN customers sc ON sc.id = bt.suggested_client_id
`;

// ── Query ─────────────────────────────────────────────────────────────────────

export async function getBankTransactions(
  companyId: string,
  filters?: BankTxFilters
): Promise<{ transactions: BankTransaction[]; total: number }> {
  try {
    const limit = filters?.limit || 100;
    const offset = filters?.offset || 0;
    let rows: Row[];
    let countRows: Row[];

    if (filters?.reconciliationId) {
      rows = (await sql`${TX_SELECT}
        WHERE bt.reconciliation_id = ${filters.reconciliationId}::UUID
        ORDER BY bt.transaction_date DESC, bt.amount DESC
        LIMIT ${limit} OFFSET ${offset}`) as Row[];
      countRows = (await sql`SELECT COUNT(*) AS cnt FROM bank_transactions
        WHERE reconciliation_id = ${filters.reconciliationId}::UUID`) as Row[];
    } else if (filters?.bankAccountId && filters?.status) {
      const searchPattern = filters.search ? `%${filters.search}%` : '%';
      const fromDate = filters.fromDate || '1900-01-01';
      const toDate = filters.toDate || '2099-12-31';
      const fromAmt = filters.fromAmount || '-999999999';
      const toAmt = filters.toAmount || '999999999';
      let statusArr: string[];
      if (filters.status === 'imported') {
        if (filters.allocationFilter === 'unallocated') statusArr = ['imported'];
        else if (filters.allocationFilter === 'allocated') statusArr = ['allocated'];
        else statusArr = ['imported', 'allocated'];
      } else {
        statusArr = [filters.status];
      }
      const txTypeCond = filters.txType === 'spent' ? 'AND bt.amount < 0'
        : filters.txType === 'received' ? 'AND bt.amount > 0' : '';
      const validAllocTypes = ['account', 'supplier', 'customer'] as const;
      const allocTypeCond = filters.allocType && validAllocTypes.includes(filters.allocType as typeof validAllocTypes[number])
        ? `AND bt.allocation_type = '${filters.allocType}'` : '';
      const hasSuggCond = filters.hasSuggestion === 'yes'
        ? 'AND (bt.suggested_gl_account_id IS NOT NULL OR bt.suggested_supplier_id IS NOT NULL OR bt.suggested_client_id IS NOT NULL)'
        : filters.hasSuggestion === 'no'
          ? 'AND bt.suggested_gl_account_id IS NULL AND bt.suggested_supplier_id IS NULL AND bt.suggested_client_id IS NULL'
          : '';
      const sortDir = filters.sortOrder === 'asc' ? 'ASC' : 'DESC';
      const extra = [txTypeCond, allocTypeCond, hasSuggCond].filter(Boolean).join(' ');
      rows = (await sql`${TX_SELECT}
        WHERE bt.bank_account_id = ${filters.bankAccountId}::UUID
          AND bt.status = ANY(${statusArr}::TEXT[])
          AND bt.transaction_date >= ${fromDate} AND bt.transaction_date <= ${toDate}
          AND bt.amount >= ${fromAmt}::NUMERIC AND bt.amount <= ${toAmt}::NUMERIC
          AND (bt.description ILIKE ${searchPattern} OR bt.reference ILIKE ${searchPattern})
          ${sql.unsafe(extra)}
        ORDER BY bt.transaction_date ${sql.unsafe(sortDir)}, bt.amount DESC
        LIMIT ${limit} OFFSET ${offset}`) as Row[];
      countRows = (await sql`SELECT COUNT(*) AS cnt FROM bank_transactions bt
        WHERE bt.bank_account_id = ${filters.bankAccountId}::UUID
          AND bt.status = ANY(${statusArr}::TEXT[])
          AND bt.transaction_date >= ${fromDate} AND bt.transaction_date <= ${toDate}
          AND bt.amount >= ${fromAmt}::NUMERIC AND bt.amount <= ${toAmt}::NUMERIC
          AND (bt.description ILIKE ${searchPattern} OR bt.reference ILIKE ${searchPattern})
          ${sql.unsafe(extra)}`) as Row[];
    } else if (filters?.bankAccountId) {
      rows = (await sql`${TX_SELECT}
        WHERE bt.bank_account_id = ${filters.bankAccountId}::UUID
        ORDER BY bt.transaction_date DESC, bt.amount DESC
        LIMIT ${limit} OFFSET ${offset}`) as Row[];
      countRows = (await sql`SELECT COUNT(*) AS cnt FROM bank_transactions
        WHERE bank_account_id = ${filters.bankAccountId}::UUID`) as Row[];
    } else {
      rows = (await sql`${TX_SELECT}
        WHERE bt.company_id = ${companyId}
        ORDER BY bt.transaction_date DESC, bt.amount DESC
        LIMIT ${limit} OFFSET ${offset}`) as Row[];
      countRows = (await sql`SELECT COUNT(*) AS cnt FROM bank_transactions
        WHERE company_id = ${companyId}`) as Row[];
    }

    return { transactions: rows.map(mapTxRow), total: Number(countRows[0]!.cnt) };
  } catch (err) {
    log.error('Failed to get bank transactions', { error: err }, 'accounting');
    throw err;
  }
}

// ── Status Mutations ──────────────────────────────────────────────────────────

export async function matchTransaction(
  companyId: string, bankTxId: string, journalLineId: string, reconciliationId?: string
): Promise<BankTransaction> {
  try {
    let rows: Row[];
    if (reconciliationId) {
      rows = (await sql`
        UPDATE bank_transactions
        SET status = 'matched', matched_journal_line_id = ${journalLineId}::UUID,
            reconciliation_id = ${reconciliationId}::UUID
        WHERE id = ${bankTxId}::UUID RETURNING *`) as Row[];
    } else {
      rows = (await sql`
        UPDATE bank_transactions
        SET status = 'matched', matched_journal_line_id = ${journalLineId}::UUID
        WHERE id = ${bankTxId}::UUID RETURNING *`) as Row[];
    }
    if (rows.length === 0) throw new Error(`Bank transaction ${bankTxId} not found`);
    log.info('Matched bank transaction', { bankTxId, journalLineId }, 'accounting');
    return mapTxRow(rows[0]!);
  } catch (err) {
    log.error('Failed to match bank transaction', { bankTxId, error: err }, 'accounting');
    throw err;
  }
}

export async function unmatchTransaction(companyId: string, bankTxId: string): Promise<BankTransaction> {
  try {
    const rows = (await sql`
      UPDATE bank_transactions
      SET status = 'imported', matched_journal_line_id = NULL,
          allocation_type = NULL, allocated_entity_name = NULL
      WHERE id = ${bankTxId}::UUID RETURNING *`) as Row[];
    if (rows.length === 0) throw new Error(`Bank transaction ${bankTxId} not found`);
    log.info('Unmatched bank transaction', { bankTxId }, 'accounting');
    return mapTxRow(rows[0]!);
  } catch (err) {
    log.error('Failed to unmatch bank transaction', { bankTxId, error: err }, 'accounting');
    throw err;
  }
}

export async function excludeTransaction(
  companyId: string, bankTxId: string, reason?: string
): Promise<BankTransaction> {
  try {
    const rows = (await sql`
      UPDATE bank_transactions SET status = 'excluded', exclude_reason = ${reason || null}
      WHERE id = ${bankTxId}::UUID RETURNING *`) as Row[];
    if (rows.length === 0) throw new Error(`Bank transaction ${bankTxId} not found`);
    log.info('Excluded bank transaction', { bankTxId, reason }, 'accounting');
    return mapTxRow(rows[0]!);
  } catch (err) {
    log.error('Failed to exclude bank transaction', { bankTxId, error: err }, 'accounting');
    throw err;
  }
}

/** Delete bank transactions — only imported (unallocated) transactions can be deleted. */
export async function deleteTransactions(companyId: string, bankTxIds: string[]): Promise<number> {
  if (bankTxIds.length === 0) return 0;
  try {
    const result = (await sql`
      DELETE FROM bank_transactions
      WHERE id = ANY(${bankTxIds}::UUID[]) AND status = 'imported'`) as Row[];
    const deleted = result.length ?? bankTxIds.length;
    log.info('Deleted bank transactions', { count: deleted, ids: bankTxIds }, 'accounting');
    return deleted;
  } catch (err) {
    log.error('Failed to delete bank transactions', { bankTxIds, error: err }, 'accounting');
    throw err;
  }
}

/** Mark a batch of imported/allocated transactions as matched without creating journal entries. */
export async function bulkAcceptTransactions(companyId: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  try {
    const result = (await sql`
      UPDATE bank_transactions SET status = 'matched', updated_at = NOW()
      WHERE id = ANY(${ids}::UUID[]) AND status IN ('imported', 'allocated')`) as Row[];
    const count = (result as unknown as { count?: number }).count ?? ids.length;
    log.info('Bulk accepted bank transactions', { count, ids }, 'accounting');
    return count;
  } catch (err) {
    log.error('Failed to bulk accept bank transactions', { ids, error: err }, 'accounting');
    throw err;
  }
}
