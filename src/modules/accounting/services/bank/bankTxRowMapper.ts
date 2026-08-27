/**
 * Bank transaction row → domain mapper. Extracted from
 * bankTransactionQueryService (300-line rule); that module re-exports both
 * helpers, so every existing import path keeps working.
 */
import type { DbRow } from '@/lib/neon';
import type { BankTransaction } from '../../types/bank.types';

type Row = DbRow;

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
    excludeReason: row.excluded_reason ? String(row.excluded_reason) : undefined,
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
    suggestedStrategy: row.suggested_strategy ? String(row.suggested_strategy) : undefined,
    cc1Id: row.cc1_id ? String(row.cc1_id) : undefined,
    cc2Id: row.cc2_id ? String(row.cc2_id) : undefined,
    buId: row.bu_id ? String(row.bu_id) : undefined,
    cc1Name: row.cc1_name ? String(row.cc1_name) : undefined,
    cc2Name: row.cc2_name ? String(row.cc2_name) : undefined,
    buName: row.bu_name ? String(row.bu_name) : undefined,
    allocationType: row.allocation_type
      ? String(row.allocation_type) as BankTransaction['allocationType'] : undefined,
    allocatedEntityName: row.allocated_entity_name ? String(row.allocated_entity_name) : undefined,
    counterpartyAccountId: row.counterparty_account_id ? String(row.counterparty_account_id) : undefined,
    transferJournalEntryId: row.transfer_journal_entry_id ? String(row.transfer_journal_entry_id) : undefined,
  };
}
