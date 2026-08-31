/**
 * Bank transaction row → domain mapper. Extracted from
 * bankTransactionQueryService (300-line rule); that module re-exports both
 * helpers, so every existing import path keeps working.
 */
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';
import type { BankTransaction } from '../../types/bank.types';

type Row = DbRow;

// The local copy of fmtDate used `toISOString()`, which renders a Date in UTC:
// on UTC+2 a timestamp between 00:00 and 02:00 SAST rolled back a day. The
// shared helper in @/lib/neon reads the local calendar date instead. Re-exported
// because callers import fmtDate from this module (and from the query service,
// which re-exports it again).
export { fmtDate };

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
    ...resolveAllocatedAccount(row),
    allocationRuleId: row.allocation_rule_id ? String(row.allocation_rule_id) : undefined,
    allocationRuleName: row.allocation_rule_name ? String(row.allocation_rule_name) : undefined,
    allocatedCounterpartyName: row.allocated_entity_name ? String(row.allocated_entity_name) : undefined,
    counterpartyAccountId: row.counterparty_account_id ? String(row.counterparty_account_id) : undefined,
    transferJournalEntryId: row.transfer_journal_entry_id ? String(row.transfer_journal_entry_id) : undefined,
  };
}

/**
 * The "Account" a bookkeeper needs is the GL account the journal actually hit.
 * `allocated_entity_name` cannot answer that: the direct-allocation path stored
 * "<code> <name>", but the rule auto-post path stored the RULE's name, so the
 * same column carried two different kinds of value and rule-allocated rows named
 * something that is not an account at all.
 *
 * TX_SELECT resolves the contra line through matched_journal_line_id, so prefer
 * that. Fall back to the cached label only where the journal cannot be reached
 * (queries that do not join the lateral, or a row whose journal was deleted, or a
 * row matched to a journal line that is not its own bank leg).
 *
 * The one thing the fallback must never do is let a rule NAME stand in for an
 * account. That is decided by comparing the cached label with the rule name, not
 * by "was this posted by a rule": since this change `bankRuleAutoPostLine` writes
 * the ACCOUNT into that column, so suppressing every rule-posted row would hide a
 * value that is now known-correct. Only the historical rows — where the two
 * strings are literally equal — are withheld.
 */
function resolveAllocatedAccount(row: Row): {
  allocatedEntityName?: string;
  allocatedAccountCode?: string;
  allocatedAccountName?: string;
} {
  const code = row.allocated_account_code ? String(row.allocated_account_code) : undefined;
  const name = row.allocated_account_name ? String(row.allocated_account_name) : undefined;
  if (name) {
    // A split posts to several contra accounts; naming one leg would read as if
    // the whole amount went there.
    const isSplit = Number(row.allocated_contra_line_count ?? 1) > 1;
    if (isSplit) return { allocatedEntityName: 'Split allocation' };
    return {
      allocatedEntityName: code ? `${code} ${name}` : name,
      allocatedAccountCode: code,
      allocatedAccountName: name,
    };
  }
  const cached = row.allocated_entity_name ? String(row.allocated_entity_name) : undefined;
  if (!cached) return {};
  const ruleName = row.allocation_rule_name ? String(row.allocation_rule_name) : undefined;
  const cachedIsTheRuleName = ruleName !== undefined && cached === ruleName;
  return { allocatedEntityName: cachedIsTheRuleName ? undefined : cached };
}
