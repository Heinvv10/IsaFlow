/**
 * Static SQL fragments shared by every getBankTransactions branch. Extracted
 * from bankTransactionQueryService (300-line rule).
 *
 * Nothing here interpolates a user value: TX_SELECT is a constant, and the
 * allocation predicate is a fixed literal keyed on a validated enum — that is
 * what makes them safe for `sql.unsafe`.
 */
import type { BankTxFilters } from './bankTxFilters';

// BL-11: Explicit column list replaces bt.* to reduce row width (~1,534→~640 bytes).
// Every field read by mapTxRow must appear here. Keep in sync with mapTxRow.
export const TX_SELECT = `
  SELECT
    bt.id, bt.company_id, bt.bank_account_id,
    bt.transaction_date, bt.value_date,
    bt.amount, bt.description, bt.reference, bt.bank_reference,
    bt.status, bt.matched_journal_line_id, bt.reconciliation_id,
    bt.import_batch_id, bt.excluded_reason, bt.notes,
    bt.suggested_gl_account_id, bt.suggested_category,
    bt.suggested_supplier_id, bt.suggested_client_id,
    bt.suggested_vat_code, bt.suggested_confidence, bt.suggested_strategy,
    bt.cc1_id, bt.cc2_id, bt.bu_id,
    bt.allocation_type, bt.allocated_entity_name,
    bt.created_at, bt.updated_at,
    ga.account_name AS bank_account_name,
    sga.account_name AS suggested_gl_account_name,
    sga.account_code AS suggested_gl_account_code,
    COALESCE(ss.company_name, ss.name) AS suggested_supplier_name,
    sc.name AS suggested_client_name
  FROM bank_transactions bt
  LEFT JOIN gl_accounts ga ON ga.id = bt.bank_account_id
  LEFT JOIN gl_accounts sga ON sga.id = bt.suggested_gl_account_id
  LEFT JOIN suppliers ss ON ss.id = bt.suggested_supplier_id
  LEFT JOIN customers sc ON sc.id = bt.suggested_client_id
`;

// allocationFilter — same definition as bankAccountStatusService counts (PRD-11 §2):
// allocated = journal posted; suggested = categorised, not posted; unallocated = neither.
// Fixed literals keyed on a validated enum — safe for sql.unsafe. Applied in EVERY branch (#256).
const HAS_CATEGORY =
  '(bt.suggested_gl_account_id IS NOT NULL OR bt.suggested_supplier_id IS NOT NULL OR bt.suggested_client_id IS NOT NULL OR bt.allocation_type IS NOT NULL)';
const NO_CATEGORY =
  'bt.suggested_gl_account_id IS NULL AND bt.suggested_supplier_id IS NULL AND bt.suggested_client_id IS NULL AND bt.allocation_type IS NULL';

export function allocationCond(f?: BankTxFilters): string {
  switch (f?.allocationFilter) {
    case 'allocated':
      return 'AND bt.matched_journal_line_id IS NOT NULL';
    case 'suggested':
      return `AND bt.matched_journal_line_id IS NULL AND ${HAS_CATEGORY} AND bt.status != 'excluded'`;
    case 'unallocated':
      return `AND bt.matched_journal_line_id IS NULL AND ${NO_CATEGORY} AND bt.status != 'excluded'`;
    default:
      return '';
  }
}
