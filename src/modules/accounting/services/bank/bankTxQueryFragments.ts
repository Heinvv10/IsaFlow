/**
 * Static SQL fragments shared by every getBankTransactions branch. Extracted
 * from bankTransactionQueryService (300-line rule).
 *
 * Nothing here interpolates a user value: TX_SELECT is a constant, and the
 * allocation predicate is a fixed literal keyed on a validated enum — that is
 * what makes them safe for `sql.unsafe`.
 */
import type { BankTxFilters } from './bankTxFilters';

// The screen's VAT column rendered `rowSelections[tx.id]?.vatCode`, seeded only
// from bt.suggested_vat_code — which the rule auto-post path NULLs the moment it
// allocates. Every rule-allocated row therefore fell through to 'none' and read
// "No VAT" while its journal had claimed input tax at 15%: R43,022.36 on one
// company's Staff Welfare alone, invisible on the one screen a reviewer checks.
// This derives the treatment from the posted journal, which is the truth.
//
// 'standard' is asserted from the PRESENCE OF A VAT-ACCOUNT LINE, not from
// gl_journal_lines.vat_type: the tax line is what reaches VAT201, and a vat_type
// left unset on the contra line would otherwise hide a real claim.
// 'vat_input_late_claim' counts too: a user allocation dated in a filed VAT
// period parks its tax there and claims it in the next period (s16(3),
// gl/vatLateClaimSplit) — still a standard-rated allocation.
// V-05 census: no auto_vat_submission exclusion is needed here. This is a
// per-transaction lateral entered through bt.matched_journal_line_id, and the
// clearing journal is not matched to any bank transaction, so it cannot reach
// this aggregate at all.
const POSTED_VAT_LATERAL = `
  SELECT
    CASE
      -- The aggregate returns one row even over ZERO journal lines, so without
      -- this arm an unallocated transaction reported 'none' — indistinguishable
      -- from one that WAS allocated and genuinely claimed nothing.
      WHEN COUNT(jl.id) = 0 THEN NULL
      WHEN SUM(CASE WHEN va.account_subtype IN ('vat_input', 'vat_output', 'vat_input_late_claim')
                    THEN ABS(COALESCE(jl.debit, 0)) + ABS(COALESCE(jl.credit, 0))
                    ELSE 0 END) > 0 THEN 'standard'
      ELSE COALESCE(
        MAX(jl.vat_type) FILTER (WHERE jl.vat_type IN ('zero_rated', 'exempt')),
        'none')
    END AS posted_vat_code,
    CASE WHEN COUNT(jl.id) = 0 THEN NULL ELSE
      SUM(CASE WHEN va.account_subtype IN ('vat_input', 'vat_output', 'vat_input_late_claim')
               THEN ABS(COALESCE(jl.debit, 0)) + ABS(COALESCE(jl.credit, 0))
               ELSE 0 END)
    END AS posted_vat_amount
  FROM gl_journal_lines mjl
  JOIN gl_journal_lines jl
    ON jl.journal_entry_id = mjl.journal_entry_id
   AND jl.company_id = mjl.company_id
  LEFT JOIN gl_accounts va ON va.id = jl.gl_account_id AND va.company_id = bt.company_id
  WHERE mjl.id = bt.matched_journal_line_id
    AND mjl.company_id = bt.company_id
`;

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
// `journal_line` branch of bank-match-confirm) writes whatever line the request
// names: `fetchJournalLineCandidates` now offers only this bank's lines in this
// line's direction, but the route does not re-check a hand-crafted id. Match a
// transaction against the expense leg of a supplier invoice and the ungated sibling is Accounts
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
      AND COALESCE(aga.account_subtype, '') NOT IN ('vat_input', 'vat_output', 'vat_input_late_claim')
    ORDER BY GREATEST(al.debit, al.credit) DESC, aga.account_code ASC
    LIMIT 1
  ) aa ON TRUE`;

// The dimensions the screen shows. The bank row's own cc1/cc2/bu when it has
// any; otherwise its allocation journal's — the lines other than the bank leg
// that carry a dimension (the dimension back-tag writes those, not the bank
// row). One agreed set → 'journal'; more than one (a split across projects)
// → 'split' with no single value; none → nothing. A supplier payment's
// journal is AP + bank, both untagged by design: its dimensions are on the bill.
const DIMENSION_JOINS = `
  LEFT JOIN LATERAL (
    SELECT (array_agg(dl.cc1_id))[1] AS cc1, (array_agg(dl.cc2_id))[1] AS cc2, (array_agg(dl.bu_id))[1] AS bu,
           COUNT(DISTINCT ROW(dl.cc1_id, dl.cc2_id, dl.bu_id)) AS sets
    FROM gl_journal_lines dbl
    JOIN gl_journal_lines dl
      ON dl.journal_entry_id = dbl.journal_entry_id
     AND dl.company_id       = dbl.company_id
     AND dl.id <> dbl.id
    WHERE dbl.id = bt.matched_journal_line_id
      AND dbl.company_id = bt.company_id
      AND (dl.cc1_id IS NOT NULL OR dl.cc2_id IS NOT NULL OR dl.bu_id IS NOT NULL)
  ) jd ON TRUE
  LEFT JOIN LATERAL (
    SELECT
      CASE WHEN bt.cc1_id IS NOT NULL OR bt.cc2_id IS NOT NULL OR bt.bu_id IS NOT NULL THEN 'bank'
           WHEN jd.sets = 1 THEN 'journal'
           WHEN jd.sets > 1 THEN 'split' END AS src
  ) dsrc ON TRUE
  LEFT JOIN cost_centres dcc1 ON dcc1.company_id = bt.company_id
    AND dcc1.id = CASE dsrc.src WHEN 'bank' THEN bt.cc1_id WHEN 'journal' THEN jd.cc1 END
  LEFT JOIN cost_centres dcc2 ON dcc2.company_id = bt.company_id
    AND dcc2.id = CASE dsrc.src WHEN 'bank' THEN bt.cc2_id WHEN 'journal' THEN jd.cc2 END
  LEFT JOIN business_units dbu ON dbu.company_id = bt.company_id
    AND dbu.id = CASE dsrc.src WHEN 'bank' THEN bt.bu_id WHEN 'journal' THEN jd.bu END`;

// The asset / fleet link (mig 853, an annotation) and what it is labelled with: the asset itself, or the asset the
// fuel / service record belongs to. Company-scoped on every join, like the FKs that hold them.
const LINK_JOINS = `
  LEFT JOIN fleet_fuel_transactions lnk_f ON lnk_f.id = bt.linked_fleet_fuel_id AND lnk_f.company_id = bt.company_id
  LEFT JOIN fleet_service_history lnk_s ON lnk_s.id = bt.linked_fleet_service_id AND lnk_s.company_id = bt.company_id
  LEFT JOIN assets lnk_a ON lnk_a.id = COALESCE(bt.linked_asset_id, lnk_f.asset_id, lnk_s.asset_id)
    AND lnk_a.company_id = bt.company_id`;

export const TX_SELECT = `
  SELECT
    bt.id, bt.company_id, bt.bank_account_id,
    bt.transaction_date, bt.value_date,
    bt.amount, bt.description, bt.reference, bt.bank_reference,
    bt.status, bt.feed_state, bt.matched_journal_line_id, bt.reconciliation_id,
    bt.import_batch_id, bt.excluded_reason, bt.notes,
    bt.suggested_gl_account_id, bt.suggested_category,
    bt.suggested_supplier_id, bt.suggested_client_id,
    bt.suggested_vat_code, bt.suggested_confidence, bt.suggested_strategy,
    bt.cc1_id, bt.cc2_id, bt.bu_id,
    dsrc.src AS dimension_source,
    dcc1.code AS cc1_code, dcc1.name AS cc1_name,
    dcc2.code AS cc2_code, dcc2.name AS cc2_name,
    dbu.code AS bu_code, dbu.name AS bu_name,
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
    sc.name AS suggested_client_name,
    pv.posted_vat_code, pv.posted_vat_amount,
    bt.linked_asset_id, bt.linked_fleet_fuel_id, bt.linked_fleet_service_id,
    lnk_a.id AS link_asset_id, lnk_a.name AS link_asset_name,
    lnk_f.fill_date AS link_fill_date, lnk_f.amount AS link_fuel_amount,
    lnk_s.description AS link_service_description
  FROM bank_transactions bt
  LEFT JOIN gl_accounts ga ON ga.id = bt.bank_account_id
  LEFT JOIN gl_accounts sga ON sga.id = bt.suggested_gl_account_id
  LEFT JOIN suppliers ss ON ss.id = bt.suggested_supplier_id
  LEFT JOIN customers sc ON sc.id = bt.suggested_client_id
  ${ALLOCATED_ACCOUNT_LATERAL}
  LEFT JOIN LATERAL (${POSTED_VAT_LATERAL}) pv ON TRUE
  ${DIMENSION_JOINS}
  ${LINK_JOINS}
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
