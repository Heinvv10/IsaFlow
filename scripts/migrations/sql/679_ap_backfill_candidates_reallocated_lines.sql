-- Migration 679: the backfill classifier must read a cancelled document's
-- JOURNAL, not just its `reference`. Re-allocated bank lines were being named
-- `document_cancelled_journal_stands` over a journal that had in fact been
-- reversed, leaving the cash their CURRENT journal moved with no document at
-- all and no outcome that said so.
--
-- REPLACES THE VIEW FROM 615 AND NOTHING ELSE. No table, no function, no data.
-- The full definition is repeated here because that is what CREATE OR REPLACE
-- VIEW takes; 615 remains the place the design is argued, and every comment it
-- carries is reproduced. Only the two document tests and one CASE arm differ,
-- and each change is marked where it sits.
--
-- ── THE SHAPE IN PRODUCTION ─────────────────────────────────────────────────
--
-- On Velocity Fibre (4a159669-2f50-46b5-a7b8-2e94dab3d495), 28 bank lines worth
-- R403,809.15 have this history:
--
--   1. The line was allocated to a supplier. That posted journal J1 and created
--      payment document D1, whose `reference` is the bank transaction id.
--   2. D1 was cancelled and J1 was reversed with it — J1 is status 'posted'
--      with `reversed_at` set AND has an entry whose `reversal_of_id` is J1.
--      All 28 carry both signals.
--   3. The line was re-allocated, by the bulk MCP tool, before #343. That
--      posted journal J2 — which is what `matched_journal_line_id` reaches
--      today — and created NO document. There is no D2.
--
-- Nothing clears `reference` when a document is cancelled, so D1 still names
-- the bank line. 615's cancelled-document test matched it on that alone and
-- classified all 28 as `document_cancelled_journal_stands` — a statement about
-- J1, which does not stand. J2 stands, its DR Accounts Payable / CR Bank entry
-- is on the control account, and no document points at it. The reconciler says
-- so from the other side: it reports the same 28 lines as
-- `posting_with_no_document`.
--
-- The correct classification is `create`, which is what this view now returns.
-- Minting is still a deliberate, per-tenant act:
-- `bun scripts/ap-backfill-supplier-payments.ts --company <uuid> [--commit]`.
--
-- ── THE OUTCOME THIS ADDS ───────────────────────────────────────────────────
--
-- Narrowing the LIVE-document test the same way exposes a shape 615 swallowed:
-- a live document carrying the bank line's id but a DIFFERENT journal. It is
-- neither `already_has_document` (its journal is not this line's) nor `create`
-- (a second live document beside it would claim the same cash twice), so it
-- gets its own outcome, `document_on_other_journal`, and is reported. Zero rows
-- in production today.
--
-- `ap_payment_document_backfill.outcome` is unaffected: its CHECK admits only
-- 'created' and 'skipped', and the view's outcome is logged in `reason`, which
-- carries no constraint. Nothing to widen.

CREATE OR REPLACE VIEW ap_payment_document_backfill_candidates AS
WITH base AS (
  SELECT
    b.id                        AS bank_transaction_id,
    b.company_id,
    b.transaction_date,
    b.bank_account_id,
    b.allocated_entity_name,
    -- The line is money out; the payment is its absolute value, which is what
    -- the journal debited to Accounts Payable.
    ROUND(ABS(b.amount), 2)     AS amount,
    jl.journal_entry_id
  FROM bank_transactions b
  -- LEFT: a line with no matched journal line must be REPORTED as such, not
  -- dropped by the join and counted nowhere.
  LEFT JOIN gl_journal_lines jl
    ON jl.id = b.matched_journal_line_id
   AND jl.company_id = b.company_id
  WHERE b.allocation_type = 'supplier'
    AND b.status = 'allocated'
    -- Money OUT only. A positive line against a supplier is a REFUND — the
    -- journal is DR Bank / CR AP and a payment document for it would be cash
    -- the company never paid. Same `isSpent` gate the forward path applies.
    AND b.amount < 0
),
resolved AS (
  SELECT
    base.*,
    -- Resolved by NAME because `bank_transactions` carries no supplier id:
    -- `allocated_entity_name` is set to `suppliers.name` by the same allocation
    -- that posted the journal. Ambiguity and absence are separate outcomes
    -- below; neither is ever guessed past.
    --
    -- WHAT THE NAME CANNOT TELL US, stated because it is the weakest link in
    -- this whole file. `suppliers` has no unique index on (company_id, name)
    -- and the name is mutable, so "exactly one match" is not the same as "the
    -- right row": rename a supplier, create a new one under the freed name,
    -- and a line allocated to the first resolves to the second. Nothing in the
    -- data can see that — `allocated_entity_name` and the journal description
    -- are the SAME frozen string written at the same moment, so there is no
    -- independent witness.
    --
    -- Two corroborating sources were measured against the 634 Velocity Fibre
    -- candidates and both are dead ends, recorded so nobody re-derives them:
    -- `suggested_supplier_id` and `predicted_supplier_id` are NULL on all 634,
    -- and the supplier row is younger than the bank line on 330 of them
    -- (a bulk import creates every supplier after the history it carries), so
    -- neither an id check nor an age check separates anything.
    --
    -- What DOES separate the impostor shape is history: a supplier freshly
    -- created under a freed name has no bills and no other payments in this
    -- tenant. That is 9 of the 634, and they are refused below rather than
    -- minted, because those 9 are a list a person can settle by hand and a
    -- document against the wrong supplier's account is not.
    (SELECT ARRAY_AGG(s.id)
       FROM suppliers s
      WHERE s.company_id = base.company_id
        AND s.name = base.allocated_entity_name
        AND s.deleted_at IS NULL)               AS supplier_ids
  FROM base
),
facts AS (
  SELECT
    resolved.*,
    -- Any ledger relationship at all between the resolved supplier and this
    -- tenant. Read from `supplier_ids` rather than a scalar subquery of its
    -- own: on an ambiguous name that subquery returns two rows and raises,
    -- which would take out the whole view over a case the CASE below refuses
    -- three lines earlier. A NULL here (no match, or two) leaves this FALSE
    -- and the ambiguity/absence outcomes decide the row.
    --
    -- `si.company_id` / `sp2.company_id` look redundant beside a supplier id
    -- and are NOT. `supplier_invoices_supplier_id_fkey` and
    -- `supplier_payments_supplier_id_fkey` reference `suppliers(id)` with no
    -- company pairing, so a bill whose supplier belongs to ANOTHER tenant is
    -- insertable — and without these filters such a row would grant history to
    -- a supplier that has none here, re-arming the exact line the guard just
    -- refused. No fixture with clean data can catch their removal; that makes
    -- them uncatchable, not unnecessary.
    CASE WHEN COALESCE(ARRAY_LENGTH(resolved.supplier_ids, 1), 0) = 1 THEN
      EXISTS (SELECT 1 FROM supplier_invoices si
               WHERE si.company_id = resolved.company_id
                 AND si.supplier_id = resolved.supplier_ids[1])
      OR EXISTS (SELECT 1 FROM supplier_payments sp2
                  WHERE sp2.company_id = resolved.company_id
                    AND sp2.supplier_id = resolved.supplier_ids[1])
    ELSE FALSE END                              AS supplier_has_history,
    je.status                                   AS journal_status,
    je.reversed_at                              AS journal_reversed_at,
    je.description                              AS journal_description,
    je.created_by                               AS journal_created_by,
    -- The whole journal must balance, and its AP leg and its bank leg must each
    -- be exactly this line's amount. Together these pin the journal to THIS
    -- bank line: `matched_journal_line_id` does not always point at the line's
    -- own bank leg, so the journal it reaches is not trusted on its word.
    (SELECT COALESCE(SUM(l.debit - l.credit), 0)
       FROM gl_journal_lines l
      WHERE l.journal_entry_id = resolved.journal_entry_id
        AND l.company_id = resolved.company_id)     AS journal_imbalance,
    (SELECT COALESCE(SUM(l.debit - l.credit), 0)
       FROM gl_journal_lines l
       JOIN gl_accounts a
         ON a.id = l.gl_account_id
        AND a.company_id = resolved.company_id
        AND a.account_subtype = 'payable'
      WHERE l.journal_entry_id = resolved.journal_entry_id
        AND l.company_id = resolved.company_id)     AS ap_debit,
    (SELECT COALESCE(SUM(l.credit - l.debit), 0)
       FROM gl_journal_lines l
      WHERE l.journal_entry_id = resolved.journal_entry_id
        AND l.company_id = resolved.company_id
        AND l.gl_account_id = resolved.bank_account_id) AS bank_credit,
    -- WHAT FINISHES A LINE, and the arm 679 narrowed.
    --
    -- The journal arm is exact: a live document carrying THIS line's journal is
    -- this line's document. The reference arm is not, and was the defect. A
    -- document written for this bank line and later moved off it — cancelled,
    -- its journal reversed, the line re-allocated onto a new one — still
    -- carries the bank transaction id in `reference` forever, because nothing
    -- clears it. So the reference alone cannot say the line is finished; it can
    -- only say so where the document has not wandered off the line's journal.
    --
    -- A NULL journal on the document is still accepted through the reference
    -- arm. That is what this backfill's own output looked like before it began
    -- setting `gl_journal_entry_id`, and a document with no journal has not
    -- wandered anywhere — there is nothing to compare.
    EXISTS (
      SELECT 1 FROM supplier_payments sp
       WHERE sp.company_id = resolved.company_id
         AND sp.status <> 'cancelled'
         AND (sp.gl_journal_entry_id = resolved.journal_entry_id
              OR (sp.reference = resolved.bank_transaction_id::TEXT
                  AND (sp.gl_journal_entry_id IS NULL
                       OR sp.gl_journal_entry_id = resolved.journal_entry_id)))
    )                                           AS has_document,
    -- THE ANOMALY THE NARROWING EXPOSES. A LIVE document written for this bank
    -- line that carries a DIFFERENT journal from the one the line now points
    -- at. It does not finish the line — its journal is not this line's — and it
    -- is not licence to mint a second one beside it, which would claim the same
    -- cash twice and silently override whatever moved the document. Zero rows
    -- in production today; named so that the day one appears it is reported
    -- rather than backfilled over.
    EXISTS (
      SELECT 1 FROM supplier_payments sp
       WHERE sp.company_id = resolved.company_id
         AND sp.status <> 'cancelled'
         AND sp.reference = resolved.bank_transaction_id::TEXT
         AND sp.gl_journal_entry_id IS NOT NULL
         AND sp.gl_journal_entry_id IS DISTINCT FROM resolved.journal_entry_id
    )                                           AS has_document_on_other_journal,
    -- A CANCELLED payment is not a document this line still has, and it is not
    -- an invitation to mint a replacement either: somebody cancelled it on
    -- purpose. Where its journal was reversed with it the pair is consistent
    -- and the journal guards below say so; where the journal still stands, the
    -- cash is on the control account behind a cancelled document and that is a
    -- separate defect, named rather than backfilled over. 28 lines worth
    -- R403,809.15 on Velocity Fibre.
    EXISTS (
      SELECT 1 FROM supplier_payments sp
       WHERE sp.company_id = resolved.company_id
         AND sp.status = 'cancelled'
         AND (sp.gl_journal_entry_id = resolved.journal_entry_id
              -- The reference arm, read as "does that journal still stand?".
              -- A cancelled document whose journal was REVERSED with it is a
              -- consistent, finished pair that says nothing about the journal
              -- this line carries now; the outcome name would be a lie and the
              -- line falls through to the ordinary create checks. A cancelled
              -- document whose journal still stands — this line's or any other
              -- — is refused and reported, which is the conservative direction
              -- and the one 615 chose.
              OR (sp.reference = resolved.bank_transaction_id::TEXT
                  AND NOT EXISTS (
                    SELECT 1 FROM gl_journal_entries d
                     WHERE d.id = sp.gl_journal_entry_id
                       AND d.company_id = resolved.company_id
                       -- THREE SIGNALS, ANY ONE OF THEM. Production carries a
                       -- reversed entry as status 'posted' WITH `reversed_at`
                       -- set and a reversing entry pointing at it (all 28 of
                       -- the lines this migration exists for), but `status`
                       -- admits 'reversed' (200_accounting_foundation) and a
                       -- reversal posted by hand may leave `reversed_at` unset.
                       -- Reading one signal only would miss a real reversal and
                       -- refuse a line that should be minted.
                       AND (d.reversed_at IS NOT NULL
                            OR d.status = 'reversed'
                            OR EXISTS (SELECT 1 FROM gl_journal_entries r
                                        WHERE r.company_id = resolved.company_id
                                          AND r.reversal_of_id = d.id))
                  )))
    )                                           AS has_cancelled_document,
    -- ONE JOURNAL, ONE BANK LINE — asserted here rather than assumed.
    -- `already_has_document` is decided partly by the journal a payment
    -- carries, so if two bank lines shared a journal, minting the document for
    -- the first would make the second read as finished forever: a silent
    -- under-backfill, cash left invisible with nothing reporting it. The shape
    -- is not hypothetical. Ten journals in production are pointed at by two
    -- bank lines each — both legs of a bank transfer, where one journal moves
    -- money between two accounts and each side's line matches it. None are on
    -- the supplier money-out path today, which is why this is a guard and not
    -- a fix, but a supplier line that ever lands in that shape is named rather
    -- than skipped in silence.
    -- COUNTS EVERY BANK ROW TOUCHING THE JOURNAL, not just the candidates: no
    -- `status`, no `allocation_type`, no sign filter. That is a superset, so an
    -- unallocated or account-allocated row on the same journal will suppress a
    -- line that is otherwise the only candidate on it. The direction is the
    -- safe one — refuse and report, never mint — and the outcome name stays
    -- literally true. Whoever works the exception list should know they may be
    -- hunting a second payment that does not exist.
    (SELECT COUNT(*) FROM bank_transactions b2
       JOIN gl_journal_lines jl2
         ON jl2.id = b2.matched_journal_line_id
        AND jl2.company_id = b2.company_id
      WHERE b2.company_id = resolved.company_id
        AND jl2.journal_entry_id = resolved.journal_entry_id
    )                                           AS lines_on_this_journal
  FROM resolved
  LEFT JOIN gl_journal_entries je
    ON je.id = resolved.journal_entry_id
   AND je.company_id = resolved.company_id
)
SELECT
  bank_transaction_id,
  company_id,
  transaction_date,
  bank_account_id,
  amount,
  journal_entry_id,
  journal_created_by,
  COALESCE(journal_description, 'Payment to ' || COALESCE(allocated_entity_name, 'supplier'))
                                                AS description,
  allocated_entity_name,
  CASE WHEN COALESCE(ARRAY_LENGTH(supplier_ids, 1), 0) = 1
       THEN supplier_ids[1] END                 AS supplier_id,
  CASE
    WHEN lines_on_this_journal > 1             THEN 'journal_shared_by_bank_lines'
    WHEN has_document                          THEN 'already_has_document'
    WHEN journal_entry_id IS NULL              THEN 'no_journal'
    -- IS DISTINCT FROM, not <>: a journal row that is missing or belongs to
    -- another company leaves this NULL, and `NULL <> 'posted'` is NULL rather
    -- than TRUE. The row would then fall through to an amount guard and be
    -- reported under a cause that is not its own.
    WHEN journal_status IS DISTINCT FROM 'posted' THEN 'journal_not_posted'
    WHEN journal_reversed_at IS NOT NULL       THEN 'journal_reversed'
    WHEN journal_imbalance <> 0                THEN 'journal_unbalanced'
    WHEN ap_debit <> amount                    THEN 'ap_debit_mismatch'
    WHEN bank_credit <> amount                 THEN 'bank_credit_mismatch'
    WHEN has_document_on_other_journal         THEN 'document_on_other_journal'
    WHEN has_cancelled_document                THEN 'document_cancelled_journal_stands'
    WHEN COALESCE(ARRAY_LENGTH(supplier_ids, 1), 0) = 0 THEN 'supplier_unresolved'
    WHEN ARRAY_LENGTH(supplier_ids, 1) > 1     THEN 'supplier_ambiguous'
    WHEN NOT supplier_has_history               THEN 'supplier_has_no_ledger_history'
    ELSE 'create'
  END                                          AS outcome
FROM facts;

COMMENT ON VIEW ap_payment_document_backfill_candidates IS
  'Every money-out supplier-allocated bank line, with what the AP payment-document '
  'backfill would do with it. Reading this is the dry run; it writes nothing.';
