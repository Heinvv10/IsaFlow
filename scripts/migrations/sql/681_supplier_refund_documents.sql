-- Migration 681: the supplier refund DOCUMENT.
--
-- ── WHAT IS MISSING FROM THE BOOKS ──────────────────────────────────────────
--
-- Cash coming BACK from a supplier posts DR Bank / CR Accounts Payable and
-- creates no subledger document at all. `allocateTransaction`'s supplier arm
-- gates the `recordSupplierBankPayment` call on `isSpent`, so a money-IN line
-- posts the journal and stops. The control account moves; the subledger does
-- not; `reconcile_subledger` reports the journal under
-- `posting_with_no_document`, and the supplier's on-account credit — which
-- every AP report computes from payment documents — is OVERSTATED by the whole
-- refund, because the cash that came back is counted nowhere against it.
--
-- ── THE SHAPE, AND WHAT IT IS NOT ───────────────────────────────────────────
--
-- A refund is a NEGATIVE ON-ACCOUNT ENTRY: a `supplier_payments` row with
-- `payment_method = 'refund'` and a NEGATIVE `total_amount`, carrying the bank
-- line's journal, `processed`, with NO `payment_allocations` rows and never
-- auto-applied. It nets against the supplier's other unapplied cash wherever
-- that is summed, which is the whole point — one supplier's on-account credit
-- is the sum of its remainders and a refund is a remainder of the other sign.
--
-- It is NOT a credit note. A credit note is the supplier reducing what it
-- billed; a refund is cash physically returning to the bank account. They hit
-- different ledgers and nothing about one is derivable from the other.
--
-- IT POSTS NO JOURNAL. The DR Bank / CR AP entry already exists and is correct;
-- this document CLAIMS it, exactly as an ordinary payment document claims the
-- DR AP / CR Bank entry that allocation posted.
--
-- ── WHY THE SIGN IS A CONSTRAINT AND NOT A CONVENTION ───────────────────────
--
-- Every reader of `supplier_payments.total_amount` was written when the column
-- could only be positive. Making it signed is safe only if the sign is pinned
-- to the one `payment_method` that means it: a negative `eft` row would be an
-- ordinary payment silently running backwards through arithmetic that has no
-- reason to expect it. So the CHECK is two-directional — a refund MUST be
-- negative and everything else MUST be positive — and it is the thing that
-- makes `payment_method = 'refund'` a reliable discriminator for readers rather
-- than a label somebody might forget to set.
--
-- Zero is excluded on both arms deliberately. A zero-value payment document
-- moves nothing, claims a journal, and appears in no unapplied total; it is a
-- ghost, and there are none today on dev, staging or production.
--
-- ── NO DATA CHANGES ─────────────────────────────────────────────────────────
--
-- This migration installs constraints and replaces the AP backfill
-- classification. The two production journals it newly classifies are minted by
-- the operator running `scripts/ap-backfill-supplier-payments.ts`, deliberately,
-- with a diff in front of them — never at deploy time.

-- ── 1. `refund` is a payment method ─────────────────────────────────────────
--
-- DROP-then-ADD rather than a new CHECK beside the old one: two overlapping
-- method constraints is how a table ends up rejecting a value that one of them
-- permits, with an error naming whichever fired first.
--
-- THE LIST IS FIVE VALUES BEFORE THIS MIGRATION, NOT FOUR, and re-deriving it
-- from 200_accounting_foundation is how this file was first written wrong.
-- Migration 540 added `'contra'` — a settlement where no cash moved, netted
-- against a receivable — and production carries 903 supplier rows under it. A
-- DROP-and-ADD that restates the original four would have been accepted by dev,
-- where 540 has never been applied, and REFUSED BY PRODUCTION by the only thing
-- standing between the two: the 903 rows themselves. Had production held none,
-- the migration would have quietly removed a settlement method the application
-- still writes (`writeSettleByContra`) and the failure would have surfaced as a
-- constraint violation on somebody's netting months later.
--
-- Applying this to dev therefore also repairs dev's drift from 540.
--
-- `customer_payments` gets it in the same breath: a CUSTOMER refund is money
-- going back OUT to a customer (DR Accounts Receivable / CR Bank) and has the
-- identical hole — `allocateTransaction`'s customer arm gates its document on
-- `!isSpent` for the mirror-image reason.
DO $$
BEGIN
  ALTER TABLE supplier_payments DROP CONSTRAINT IF EXISTS supplier_payments_payment_method_check;
  ALTER TABLE supplier_payments ADD CONSTRAINT supplier_payments_payment_method_check
    CHECK (payment_method IN ('eft', 'cheque', 'cash', 'card', 'contra', 'refund'));

  ALTER TABLE customer_payments DROP CONSTRAINT IF EXISTS customer_payments_payment_method_check;
  ALTER TABLE customer_payments ADD CONSTRAINT customer_payments_payment_method_check
    CHECK (payment_method IN ('eft', 'cheque', 'cash', 'card', 'contra', 'refund'));
END $$;

-- ── 2. The sign belongs to the method ───────────────────────────────────────
--
-- NOT VALID is deliberately NOT used. Every row on dev, staging and production
-- satisfies this today (zero rows with `total_amount <= 0` on any of the
-- three), so the table scan is the cheap half of the change and a validated
-- constraint is one the planner and every future reader can rely on. A NOT
-- VALID constraint that nobody remembers to VALIDATE is a constraint that
-- silently permits the row it exists to refuse.
--
-- `IS DISTINCT FROM` on the negative arm, not `<>`: `payment_method` is
-- nullable on both tables, and `NULL <> 'refund'` is NULL, which a CHECK
-- accepts. Without it a row with a null method and a negative total would pass
-- both arms of the constraint by being unknown to each.
DO $$
BEGIN
  ALTER TABLE supplier_payments DROP CONSTRAINT IF EXISTS supplier_payments_refund_sign_check;
  ALTER TABLE supplier_payments ADD CONSTRAINT supplier_payments_refund_sign_check
    CHECK ((payment_method = 'refund' AND total_amount < 0)
           OR (payment_method IS DISTINCT FROM 'refund' AND total_amount > 0));

  ALTER TABLE customer_payments DROP CONSTRAINT IF EXISTS customer_payments_refund_sign_check;
  ALTER TABLE customer_payments ADD CONSTRAINT customer_payments_refund_sign_check
    CHECK ((payment_method = 'refund' AND total_amount < 0)
           OR (payment_method IS DISTINCT FROM 'refund' AND total_amount > 0));
END $$;

COMMENT ON CONSTRAINT supplier_payments_refund_sign_check ON supplier_payments IS
  'A refund is cash returning from the supplier and is the only negative '
  'supplier_payments row there is. Pinning the sign to the method is what lets '
  'a reader discriminate on payment_method instead of on the sign.';

-- ── 3. The backfill classification, extended to the refund direction ────────
--
-- Replaces 680''s view. Three things change and nothing else:
--
--   · `base` no longer filters `b.amount < 0`. A supplier-allocated money-IN
--     line is a candidate now, carrying `direction = 'refund'`.
--   · the journal guards are stated as SIGNED MOVEMENTS rather than as a debit
--     and a credit, so one expression serves both directions and the two cannot
--     drift apart. A payment moves AP +amount and the bank +amount (in the
--     "cash left" sense); a refund moves both by −amount.
--   · an `account`-allocated money-IN line whose journal CREDITS the AP control
--     is admitted solely to be REPORTED, under `refund_on_control_unresolved`.
--     It is never minted and it is the reason that outcome exists: the line
--     names a GL account, not a supplier, so there is no supplier whose
--     on-account credit the refund belongs to. On production that is RohCap,
--     R120,290.00, and no amount of SQL can decide whose money it is.
--
-- `ap_journal_entry_is_reversed` (680) is unchanged and still the only
-- definition of reversed.
CREATE OR REPLACE VIEW ap_payment_document_backfill_candidates AS
WITH base AS (
  SELECT
    b.id                        AS bank_transaction_id,
    b.company_id,
    b.transaction_date,
    b.bank_account_id,
    b.allocated_entity_name,
    b.allocation_type,
    -- Always the gross line value. The SIGN of the document is derived from
    -- `direction` at the point of writing, so nothing downstream has to
    -- remember which way an absolute value was meant to point.
    ROUND(ABS(b.amount), 2)     AS amount,
    CASE WHEN b.amount < 0 THEN 'payment' ELSE 'refund' END AS direction,
    jl.journal_entry_id
  FROM bank_transactions b
  -- LEFT: a line with no matched journal line must be REPORTED as such, not
  -- dropped by the join and counted nowhere.
  LEFT JOIN gl_journal_lines jl
    ON jl.id = b.matched_journal_line_id
   AND jl.company_id = b.company_id
  WHERE b.status = 'allocated'
    -- A zero line moves nothing and has no direction to derive.
    AND b.amount <> 0
    AND (
      b.allocation_type = 'supplier'
      -- THE CONTROL-ACCOUNT SHAPE, admitted to be named and refused.
      --
      -- A deposit allocated straight to the AP control account is a refund
      -- posted without naming whose refund it is. `l.credit > 0` rather than
      -- any payable leg: a money-in line that DEBITS AP is an ordinary
      -- settlement booked by hand and not this shape at all.
      OR (b.allocation_type = 'account' AND b.amount > 0
          AND EXISTS (
            SELECT 1 FROM gl_journal_lines l
              JOIN gl_accounts a
                ON a.id = l.gl_account_id
               AND a.company_id = l.company_id
               AND a.account_subtype = 'payable'
             WHERE l.journal_entry_id = jl.journal_entry_id
               AND l.company_id = b.company_id
               AND l.credit > 0))
    )
),
resolved AS (
  SELECT
    base.*,
    -- Resolved by NAME because `bank_transactions` carries no supplier id. See
    -- 680 for the full account of what the name cannot tell us and why
    -- `supplier_has_history` is the one signal that separates an impostor.
    --
    -- An `account`-allocated line resolves to nothing here — its
    -- `allocated_entity_name` is a GL account label such as
    -- '2110 Accounts Payable' — which is exactly the fact that makes it
    -- unresolvable rather than a failure to look hard enough.
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
    -- See 680: `si.company_id` / `sp2.company_id` are load-bearing beside the
    -- supplier id, because neither FK pairs the company.
    CASE WHEN COALESCE(ARRAY_LENGTH(resolved.supplier_ids, 1), 0) = 1 THEN
      EXISTS (SELECT 1 FROM supplier_invoices si
               WHERE si.company_id = resolved.company_id
                 AND si.supplier_id = resolved.supplier_ids[1])
      OR EXISTS (SELECT 1 FROM supplier_payments sp2
                  WHERE sp2.company_id = resolved.company_id
                    AND sp2.supplier_id = resolved.supplier_ids[1])
    ELSE FALSE END                              AS supplier_has_history,
    je.status                                   AS journal_status,
    ap_journal_entry_is_reversed(resolved.company_id, resolved.journal_entry_id)
                                                AS journal_reversed,
    je.description                              AS journal_description,
    je.created_by                               AS journal_created_by,
    (SELECT COALESCE(SUM(l.debit - l.credit), 0)
       FROM gl_journal_lines l
      WHERE l.journal_entry_id = resolved.journal_entry_id
        AND l.company_id = resolved.company_id)     AS journal_imbalance,
    -- SIGNED, and read against `direction` below. A payment DEBITS the control
    -- account by the line amount; a refund CREDITS it by the same. Expressing
    -- both as one movement is what stops the two directions acquiring separate
    -- guards that can disagree — 680 was written because exactly that had
    -- happened to the reversal predicate.
    (SELECT COALESCE(SUM(l.debit - l.credit), 0)
       FROM gl_journal_lines l
       JOIN gl_accounts a
         ON a.id = l.gl_account_id
        AND a.company_id = resolved.company_id
        AND a.account_subtype = 'payable'
      WHERE l.journal_entry_id = resolved.journal_entry_id
        AND l.company_id = resolved.company_id)     AS ap_movement,
    -- Positive when cash LEFT the bank account, so a payment and its control
    -- leg carry the same sign and one comparison covers both legs.
    (SELECT COALESCE(SUM(l.credit - l.debit), 0)
       FROM gl_journal_lines l
      WHERE l.journal_entry_id = resolved.journal_entry_id
        AND l.company_id = resolved.company_id
        AND l.gl_account_id = resolved.bank_account_id) AS bank_movement,
    -- See 680 for why the reference arm is narrowed by the journal. A refund
    -- document is found by the same two arms as any other: it carries the
    -- journal and the bank transaction id, in the same columns.
    EXISTS (
      SELECT 1 FROM supplier_payments sp
       WHERE sp.company_id = resolved.company_id
         AND sp.status <> 'cancelled'
         AND (sp.gl_journal_entry_id = resolved.journal_entry_id
              OR (sp.reference = resolved.bank_transaction_id::TEXT
                  AND (sp.gl_journal_entry_id IS NULL
                       OR sp.gl_journal_entry_id = resolved.journal_entry_id)))
    )                                           AS has_document,
    EXISTS (
      SELECT 1 FROM supplier_payments sp
       WHERE sp.company_id = resolved.company_id
         AND sp.status <> 'cancelled'
         AND sp.reference = resolved.bank_transaction_id::TEXT
         AND sp.gl_journal_entry_id IS NOT NULL
         AND sp.gl_journal_entry_id IS DISTINCT FROM resolved.journal_entry_id
    )                                           AS has_document_on_other_journal,
    EXISTS (
      SELECT 1 FROM supplier_payments sp
       WHERE sp.company_id = resolved.company_id
         AND sp.status = 'cancelled'
         AND (sp.gl_journal_entry_id = resolved.journal_entry_id
              OR (sp.reference = resolved.bank_transaction_id::TEXT
                  AND sp.gl_journal_entry_id IS NOT NULL
                  AND NOT ap_journal_entry_is_reversed(
                        resolved.company_id, sp.gl_journal_entry_id)))
    )                                           AS has_cancelled_document,
    -- See 680. Counts every bank row touching the journal, not just candidates.
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
  COALESCE(
    journal_description,
    CASE WHEN direction = 'refund' THEN 'Refund from ' ELSE 'Payment to ' END
      || COALESCE(allocated_entity_name, 'supplier'))
                                                AS description,
  allocated_entity_name,
  CASE WHEN COALESCE(ARRAY_LENGTH(supplier_ids, 1), 0) = 1
       THEN supplier_ids[1] END                 AS supplier_id,
  CASE
    -- FIRST, and before every supplier guard below it. The line names a GL
    -- account; there is no supplier, so `supplier_unresolved` would be a true
    -- statement pointing at the wrong remedy — nobody can resolve this by
    -- fixing a supplier name. It is reported and never minted.
    WHEN allocation_type = 'account'           THEN 'refund_on_control_unresolved'
    WHEN lines_on_this_journal > 1             THEN 'journal_shared_by_bank_lines'
    WHEN has_document                          THEN 'already_has_document'
    WHEN journal_entry_id IS NULL              THEN 'no_journal'
    -- IS DISTINCT FROM, not <>: see 680.
    WHEN journal_status IS DISTINCT FROM 'posted' THEN 'journal_not_posted'
    WHEN journal_reversed                      THEN 'journal_reversed'
    WHEN journal_imbalance <> 0                THEN 'journal_unbalanced'
    -- One comparison per leg, both directions, by the signed movement above.
    WHEN ap_movement <> CASE WHEN direction = 'refund' THEN -amount ELSE amount END
      THEN CASE WHEN direction = 'refund' THEN 'ap_credit_mismatch' ELSE 'ap_debit_mismatch' END
    WHEN bank_movement <> CASE WHEN direction = 'refund' THEN -amount ELSE amount END
      THEN CASE WHEN direction = 'refund' THEN 'bank_debit_mismatch' ELSE 'bank_credit_mismatch' END
    WHEN has_document_on_other_journal         THEN 'document_on_other_journal'
    WHEN has_cancelled_document                THEN 'document_cancelled_journal_stands'
    WHEN COALESCE(ARRAY_LENGTH(supplier_ids, 1), 0) = 0 THEN 'supplier_unresolved'
    WHEN ARRAY_LENGTH(supplier_ids, 1) > 1     THEN 'supplier_ambiguous'
    WHEN NOT supplier_has_history               THEN 'supplier_has_no_ledger_history'
    WHEN direction = 'refund'                  THEN 'create_refund'
    ELSE 'create'
  END                                          AS outcome,
  -- APPENDED, not slotted in beside `amount` where it belongs to the reader.
  -- CREATE OR REPLACE VIEW may only add columns at the END of the list; a
  -- column inserted mid-list is rejected outright, and reordering the existing
  -- ten to make room would break every positional reader for nothing.
  direction
FROM facts;

COMMENT ON VIEW ap_payment_document_backfill_candidates IS
  'Every supplier-allocated bank line in either direction, plus the deposits '
  'allocated straight to the AP control account, with what the AP '
  'payment-document backfill would do with each. Reading this is the dry run; '
  'it writes nothing.';

-- ── 4. The run, minting both directions ─────────────────────────────────────
--
-- Replaces 615''s function. The payment arm is byte-for-byte what it was; the
-- refund arm is a second INSERT beside it rather than a `CASE` inside the
-- first, because the two write different methods and different signs and a
-- reader should be able to see the refund''s shape without deriving it.
CREATE OR REPLACE FUNCTION ap_backfill_supplier_payment_documents(
  p_company_id UUID DEFAULT NULL,
  p_batch_id   UUID DEFAULT gen_random_uuid()
)
RETURNS TABLE (
  result_batch_id UUID,
  result_outcome  TEXT,
  result_reason   TEXT,
  line_count      BIGINT,
  line_amount     NUMERIC
)
LANGUAGE plpgsql
AS $fn$
BEGIN
  -- SKIPS ARE LOGGED FIRST, and the order is load-bearing: after the INSERTs
  -- below, this run's own creations would classify as `already_has_document`
  -- and be logged a second time as skipped.
  --
  -- `refund_on_control_unresolved` lands here, which is the whole of its
  -- handling: a durable, per-batch record that the cash was seen, classified,
  -- and deliberately not minted.
  INSERT INTO ap_payment_document_backfill (
    batch_id, company_id, bank_transaction_id, journal_entry_id,
    supplier_id, supplier_payment_id, amount, outcome, reason
  )
  SELECT p_batch_id, c.company_id, c.bank_transaction_id, c.journal_entry_id,
         c.supplier_id, NULL, c.amount, 'skipped', c.outcome
  FROM ap_payment_document_backfill_candidates c
  WHERE c.outcome NOT IN ('create', 'create_refund')
    AND (p_company_id IS NULL OR c.company_id = p_company_id);

  -- The document, and only the document. No journal, no allocation, no
  -- `amount_paid`. See 615 for why `created_by` is the journal's author and
  -- why `payment_number` is left to trg_sp_payment_number.
  WITH cand AS (
    SELECT * FROM ap_payment_document_backfill_candidates c
     WHERE c.outcome = 'create'
       AND (p_company_id IS NULL OR c.company_id = p_company_id)
  ),
  ins AS (
    INSERT INTO supplier_payments (
      company_id, supplier_id, payment_date, total_amount, payment_method,
      bank_account_id, reference, description, status, gl_journal_entry_id,
      created_by, approved_by, approved_at, processed_at
    )
    SELECT cand.company_id, cand.supplier_id, cand.transaction_date, cand.amount, 'eft',
           cand.bank_account_id, cand.bank_transaction_id::TEXT, cand.description,
           'processed', cand.journal_entry_id,
           cand.journal_created_by, cand.journal_created_by, NOW(), NOW()
    FROM cand
    RETURNING id, company_id, supplier_id, reference, gl_journal_entry_id, total_amount
  )
  INSERT INTO ap_payment_document_backfill (
    batch_id, company_id, bank_transaction_id, journal_entry_id,
    supplier_id, supplier_payment_id, amount, outcome, reason
  )
  SELECT p_batch_id, ins.company_id, ins.reference::UUID, ins.gl_journal_entry_id,
         ins.supplier_id, ins.id, ins.total_amount, 'created', 'backfilled'
  FROM ins;

  -- The refund arm. `-cand.amount` and `'refund'` together are the whole
  -- difference; every other column is the payment arm's.
  --
  -- The LOG row carries the GROSS line value, not the signed total: it sits
  -- beside skipped rows that carry the same gross, and a batch summary whose
  -- amounts change sign by outcome cannot be read down a column.
  WITH cand AS (
    SELECT * FROM ap_payment_document_backfill_candidates c
     WHERE c.outcome = 'create_refund'
       AND (p_company_id IS NULL OR c.company_id = p_company_id)
  ),
  ins AS (
    INSERT INTO supplier_payments (
      company_id, supplier_id, payment_date, total_amount, payment_method,
      bank_account_id, reference, description, status, gl_journal_entry_id,
      created_by, approved_by, approved_at, processed_at
    )
    SELECT cand.company_id, cand.supplier_id, cand.transaction_date, -cand.amount, 'refund',
           cand.bank_account_id, cand.bank_transaction_id::TEXT, cand.description,
           'processed', cand.journal_entry_id,
           cand.journal_created_by, cand.journal_created_by, NOW(), NOW()
    FROM cand
    RETURNING id, company_id, supplier_id, reference, gl_journal_entry_id, total_amount
  )
  INSERT INTO ap_payment_document_backfill (
    batch_id, company_id, bank_transaction_id, journal_entry_id,
    supplier_id, supplier_payment_id, amount, outcome, reason
  )
  SELECT p_batch_id, ins.company_id, ins.reference::UUID, ins.gl_journal_entry_id,
         ins.supplier_id, ins.id, ABS(ins.total_amount), 'created', 'backfilled_refund'
  FROM ins;

  RETURN QUERY
  SELECT p_batch_id, l.outcome, l.reason, COUNT(*)::BIGINT, COALESCE(SUM(l.amount), 0)
  FROM ap_payment_document_backfill l
  WHERE l.batch_id = p_batch_id
  GROUP BY l.outcome, l.reason
  ORDER BY l.outcome, l.reason;
END;
$fn$;
