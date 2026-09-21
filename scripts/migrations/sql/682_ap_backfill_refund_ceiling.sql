-- Migration 682: the refund ceiling the BATCH path did not have.
--
-- ── THE GAP ─────────────────────────────────────────────────────────────────
--
-- 681 gave the live path a ceiling: `planSupplierRefund` refuses a refund
-- larger than the supplier's on-account credit as at the payment date, because
-- a refund returns credit the company was holding and cannot return more than
-- it held. Past that point the supplier owes the company, which is a
-- receivable and belongs on no payable document.
--
-- The backfill minted `create_refund` regardless. Two paths writing the same
-- document under two different rules is the defect class this whole workstream
-- exists to remove — and the batch path is the one running over history nobody
-- is watching, so it is the worse half to leave ungoverned.
--
-- The ceiling is now ONE definition, `ap_supplier_on_account_credit`, and the
-- view reports `refund_exceeds_credit` for a line that breaches it. Reported,
-- never minted: the cash is real and somebody has to decide what it was.
--
-- ── WHY THE RUN MATERIALISES ITS CLASSIFICATION ─────────────────────────────
--
-- 615's function drove all three statements off the VIEW, relying on statement
-- ORDER to stay coherent: skips are logged first, because after the INSERT this
-- run's own creations would classify `already_has_document` and be logged a
-- second time as skipped.
--
-- The ceiling breaks that arrangement, and silently. The payment arm mints
-- documents, those documents RAISE the supplier's on-account credit, and the
-- refund arm re-evaluating the view a statement later would see the new figure.
-- A line logged `refund_exceeds_credit` at skip time could then be minted by
-- the very same batch — one bank line carrying both a skipped row and a created
-- row, with no constraint to catch it because the two are different outcomes.
--
-- So the run takes ONE snapshot of the classification into a temp table and
-- drives all three statements off that. The order dependency is gone rather
-- than re-tuned, and the ceiling is measured against the books as the operator
-- read them in the dry run — not against a mid-run state nobody ever sees.
--
-- `pg_temp.` is spelled out on the DROP. `pg_temp` is searched FIRST, so an
-- unqualified name here would be resolved against whatever a caller happens to
-- have created, and a function that writes financial documents must not take
-- its input from a relation a caller can substitute.
--
-- ── NO DATA CHANGES ─────────────────────────────────────────────────────────
--
-- Constraints and classification only. Nothing is minted at deploy time.

-- ── The credit, in one place ────────────────────────────────────────────────
--
-- The predicate is `shared/unappliedPaymentBasis`'s AP arm, clause for clause,
-- restricted to one supplier and returned netted. It is NOT a fourth definition
-- of unapplied cash — `ap/supplierRefundDocument.getSupplierOnAccountCredit`
-- runs the identical statement on the live path, and
-- `tests/integration/supplier-refund-document.int.test.ts` proves the two agree
-- on the same tenant.
--
-- `GREATEST(sp.total_amount, 0)` is the allocation cap and the reason this
-- cannot reuse the plain `LEAST(allocated, total_amount)` form: on a refund
-- that caps the allocations at the NEGATIVE total, the remainder computes to
-- exactly zero, and an earlier refund stops reducing the credit — so a second
-- refund would be measured against a ceiling the first had already consumed.
--
-- STABLE, not IMMUTABLE: it reads tables. INVOKER rights, not DEFINER: this is
-- read by a view a tenant may select from, and a definer-rights reader of
-- `supplier_payments` would see across companies. `p_company_id` is not
-- decoration — `supplier_payments_supplier_id_fkey` does not pair the company,
-- so a row belonging to another tenant is insertable and must not grant credit
-- here.
CREATE OR REPLACE FUNCTION ap_supplier_on_account_credit(
  p_company_id  UUID,
  p_supplier_id UUID,
  p_as_at       DATE
)
RETURNS NUMERIC
LANGUAGE sql
STABLE
AS $fn$
  SELECT COALESCE(SUM(
           sp.total_amount
           - LEAST(COALESCE(alloc.allocated, 0), GREATEST(sp.total_amount, 0))
         ), 0)
    FROM supplier_payments sp
    LEFT JOIN LATERAL (
      SELECT SUM(pa.amount_allocated) AS allocated
        FROM payment_allocations pa
       WHERE pa.payment_id = sp.id
    ) alloc ON TRUE
   WHERE sp.company_id = p_company_id
     AND sp.supplier_id = p_supplier_id
     AND sp.status IN ('processed', 'reconciled')
     AND sp.payment_date <= p_as_at;
$fn$;

COMMENT ON FUNCTION ap_supplier_on_account_credit(UUID, UUID, DATE) IS
  'What a supplier has sitting on account as at a date: the sum of its '
  'processed and reconciled payments'' unapplied remainders, with earlier '
  'refunds netted off because a refund is a remainder of the other sign. The '
  'single definition the refund ceiling reads, on the live path and in the '
  'back-fill classification alike.';

-- ── The classification, with the ceiling ────────────────────────────────────
--
-- Replaces 681's view. `on_account_credit` is APPENDED (CREATE OR REPLACE VIEW
-- may only add columns at the end) and is computed ONLY for a refund line whose
-- supplier resolved — it is one aggregate per row, and the 2,191 payment lines
-- on the largest production tenant have no use for it.
CREATE OR REPLACE VIEW ap_payment_document_backfill_candidates AS
WITH base AS (
  SELECT
    b.id                        AS bank_transaction_id,
    b.company_id,
    b.transaction_date,
    b.bank_account_id,
    b.allocated_entity_name,
    b.allocation_type,
    ROUND(ABS(b.amount), 2)     AS amount,
    CASE WHEN b.amount < 0 THEN 'payment' ELSE 'refund' END AS direction,
    jl.journal_entry_id
  FROM bank_transactions b
  LEFT JOIN gl_journal_lines jl
    ON jl.id = b.matched_journal_line_id
   AND jl.company_id = b.company_id
  WHERE b.status = 'allocated'
    AND b.amount <> 0
    AND (
      b.allocation_type = 'supplier'
      -- See 681: a deposit allocated straight to the AP control account is a
      -- refund posted without naming whose refund it is.
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
    -- 680 for what the name cannot tell us and why history is the one signal
    -- that separates a rename-and-reuse impostor.
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
    -- See 680: the company filters are load-bearing beside the supplier id,
    -- because neither FK pairs the company.
    CASE WHEN COALESCE(ARRAY_LENGTH(resolved.supplier_ids, 1), 0) = 1 THEN
      EXISTS (SELECT 1 FROM supplier_invoices si
               WHERE si.company_id = resolved.company_id
                 AND si.supplier_id = resolved.supplier_ids[1])
      OR EXISTS (SELECT 1 FROM supplier_payments sp2
                  WHERE sp2.company_id = resolved.company_id
                    AND sp2.supplier_id = resolved.supplier_ids[1])
    ELSE FALSE END                              AS supplier_has_history,
    -- 682: the ceiling, as at the LINE'S OWN DATE. Not today's date: a refund
    -- is judged against the credit that existed when the money went back, and
    -- cash applied since cannot retrospectively make a correct refund wrong.
    CASE WHEN resolved.direction = 'refund'
          AND COALESCE(ARRAY_LENGTH(resolved.supplier_ids, 1), 0) = 1
         THEN ap_supplier_on_account_credit(
                resolved.company_id, resolved.supplier_ids[1], resolved.transaction_date)
    END                                         AS on_account_credit,
    je.status                                   AS journal_status,
    ap_journal_entry_is_reversed(resolved.company_id, resolved.journal_entry_id)
                                                AS journal_reversed,
    je.description                              AS journal_description,
    je.created_by                               AS journal_created_by,
    (SELECT COALESCE(SUM(l.debit - l.credit), 0)
       FROM gl_journal_lines l
      WHERE l.journal_entry_id = resolved.journal_entry_id
        AND l.company_id = resolved.company_id)     AS journal_imbalance,
    -- SIGNED, and read against `direction` below. See 681.
    (SELECT COALESCE(SUM(l.debit - l.credit), 0)
       FROM gl_journal_lines l
       JOIN gl_accounts a
         ON a.id = l.gl_account_id
        AND a.company_id = resolved.company_id
        AND a.account_subtype = 'payable'
      WHERE l.journal_entry_id = resolved.journal_entry_id
        AND l.company_id = resolved.company_id)     AS ap_movement,
    (SELECT COALESCE(SUM(l.credit - l.debit), 0)
       FROM gl_journal_lines l
      WHERE l.journal_entry_id = resolved.journal_entry_id
        AND l.company_id = resolved.company_id
        AND l.gl_account_id = resolved.bank_account_id) AS bank_movement,
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
    WHEN allocation_type = 'account'           THEN 'refund_on_control_unresolved'
    WHEN lines_on_this_journal > 1             THEN 'journal_shared_by_bank_lines'
    WHEN has_document                          THEN 'already_has_document'
    WHEN journal_entry_id IS NULL              THEN 'no_journal'
    WHEN journal_status IS DISTINCT FROM 'posted' THEN 'journal_not_posted'
    WHEN journal_reversed                      THEN 'journal_reversed'
    WHEN journal_imbalance <> 0                THEN 'journal_unbalanced'
    WHEN ap_movement <> CASE WHEN direction = 'refund' THEN -amount ELSE amount END
      THEN CASE WHEN direction = 'refund' THEN 'ap_credit_mismatch' ELSE 'ap_debit_mismatch' END
    WHEN bank_movement <> CASE WHEN direction = 'refund' THEN -amount ELSE amount END
      THEN CASE WHEN direction = 'refund' THEN 'bank_debit_mismatch' ELSE 'bank_credit_mismatch' END
    WHEN has_document_on_other_journal         THEN 'document_on_other_journal'
    WHEN has_cancelled_document                THEN 'document_cancelled_journal_stands'
    WHEN COALESCE(ARRAY_LENGTH(supplier_ids, 1), 0) = 0 THEN 'supplier_unresolved'
    WHEN ARRAY_LENGTH(supplier_ids, 1) > 1     THEN 'supplier_ambiguous'
    WHEN NOT supplier_has_history               THEN 'supplier_has_no_ledger_history'
    -- 682: THE CEILING, and it sits below every guard above it deliberately. A
    -- line whose journal is unbalanced is not a refund question, and reporting
    -- it as one would send somebody to look at a supplier's account instead of
    -- at the journal.
    --
    -- `COALESCE(on_account_credit, 0)` cannot be NULL here — every path that
    -- leaves it NULL is caught by an outcome above — and where the impossible
    -- happens it refuses rather than mints, which is the safe direction.
    WHEN direction = 'refund'
     AND amount > COALESCE(on_account_credit, 0) THEN 'refund_exceeds_credit'
    WHEN direction = 'refund'                  THEN 'create_refund'
    ELSE 'create'
  END                                          AS outcome,
  direction,
  -- Appended for the same reason `direction` was: CREATE OR REPLACE VIEW may
  -- only add columns at the end. NULL on every payment line and on any refund
  -- whose supplier did not resolve.
  on_account_credit
FROM facts;

COMMENT ON VIEW ap_payment_document_backfill_candidates IS
  'Every supplier-allocated bank line in either direction, plus the deposits '
  'allocated straight to the AP control account, with what the AP '
  'payment-document backfill would do with each. A refund larger than the '
  'supplier''s on-account credit as at the line''s own date is reported under '
  'refund_exceeds_credit and never minted. Reading this is the dry run; it '
  'writes nothing.';

-- ── The run, off ONE snapshot ───────────────────────────────────────────────
--
-- Replaces 681's function. The three INSERTs are unchanged in what they write;
-- what changes is that all three read `ap_pdb_run` — a single materialisation
-- of the classification — rather than re-evaluating the view between writes.
-- See the header for the double-logging this closes.
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
  -- DROP first: two calls in one transaction — which the integration suite
  -- makes, and an operator running two tenants back to back would — otherwise
  -- die on "relation already exists" before either has written anything.
  DROP TABLE IF EXISTS pg_temp.ap_pdb_run;
  CREATE TEMP TABLE ap_pdb_run ON COMMIT DROP AS
    SELECT * FROM ap_payment_document_backfill_candidates c
     WHERE p_company_id IS NULL OR c.company_id = p_company_id;

  INSERT INTO ap_payment_document_backfill (
    batch_id, company_id, bank_transaction_id, journal_entry_id,
    supplier_id, supplier_payment_id, amount, outcome, reason
  )
  SELECT p_batch_id, c.company_id, c.bank_transaction_id, c.journal_entry_id,
         c.supplier_id, NULL, c.amount, 'skipped', c.outcome
  FROM ap_pdb_run c
  WHERE c.outcome NOT IN ('create', 'create_refund');

  -- The document, and only the document. No journal, no allocation, no
  -- `amount_paid`. See 615 for why `created_by` is the journal's author and why
  -- `payment_number` is left to trg_sp_payment_number.
  WITH cand AS (
    SELECT * FROM ap_pdb_run c WHERE c.outcome = 'create'
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

  -- The refund arm. `-cand.amount` and `'refund'` are the whole difference.
  --
  -- The LOG row carries the GROSS line value, not the signed total: it sits
  -- beside skipped rows carrying the same gross, and a batch summary whose
  -- amounts change sign by outcome cannot be read down a column.
  WITH cand AS (
    SELECT * FROM ap_pdb_run c WHERE c.outcome = 'create_refund'
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
