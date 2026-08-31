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

// Where the money actually went. bt.allocated_entity_name is NOT trustworthy for
// this: the rule auto-post path wrote the RULE's name into it ("ROMANS PIZZA"),
// so the Account column showed a string that is not an account. The journal is
// the only authority, and matched_journal_line_id is one join away from it —
// resolve through the bank line's siblings instead of trusting the cached label.
//
// `bl.gl_account_id = bt.bank_account_id` is the load-bearing guard, not a
// tightening: "the sibling of the matched line" is only the destination when the
// matched line is THIS transaction's own bank leg. The allocate / split /
// rule-auto-post paths all write that leg, but `matchTransaction` (the
// `journal_line` branch of bank-match-confirm) writes whatever line the user
// picked from `fetchJournalLineCandidates`, which offers EVERY posted line in the
// company ranked by amount — no account filter at all. Match a transaction against
// the expense leg of a supplier invoice and the ungated sibling is Accounts
// Payable, which this column would then present as where the money went. Those
// rows resolve to nothing here and fall back to the honest "Allocated", exactly as
// before. A user who picks the bank's OWN leg still resolves, and now names the
// account.
//
// The bank line itself is excluded (al.id <> bl.id) but a sibling BANK account is
// kept: that is exactly the contra account of a transfer allocation. VAT lines are
// excluded because they are mechanics, not the destination. contra_line_count is a
// COUNT(*) OVER () — window functions run before LIMIT, so it counts every
// candidate, letting the mapper say "Split allocation" instead of naming one leg
// of a split as if it were the whole posting.
const ALLOCATED_ACCOUNT_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT
      aga.account_code,
      aga.account_name,
      COUNT(*) OVER () AS contra_line_count
    FROM gl_journal_lines bl
    JOIN gl_journal_lines al
      ON al.journal_entry_id = bl.journal_entry_id
     AND al.company_id       = bl.company_id
     AND al.id <> bl.id
    JOIN gl_accounts aga
      ON aga.id = al.gl_account_id
     AND aga.company_id = bl.company_id
    WHERE bl.id = bt.matched_journal_line_id
      AND bl.company_id = bt.company_id
      AND bl.gl_account_id = bt.bank_account_id
      AND COALESCE(aga.account_subtype, '') NOT IN ('vat_input', 'vat_output')
    ORDER BY GREATEST(al.debit, al.credit) DESC, aga.account_code ASC
    LIMIT 1
  ) aa ON TRUE`;

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
    bt.allocation_rule_id, bt.allocation_rule_name,
    bt.created_at, bt.updated_at,
    aa.account_code AS allocated_account_code,
    aa.account_name AS allocated_account_name,
    aa.contra_line_count AS allocated_contra_line_count,
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
  ${ALLOCATED_ACCOUNT_LATERAL}
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
