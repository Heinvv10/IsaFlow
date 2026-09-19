-- Migration 683: the refund ceiling is CUMULATIVE per supplier.
--
-- ── THE GAP 682 LEFT ────────────────────────────────────────────────────────
--
-- 682 checks each refund line against the supplier's on-account credit as at
-- that line's date, and the view can do no better: every row is an independent
-- expression evaluated against the books as they stand, and the books do not
-- yet contain any of the documents this run is about to mint.
--
-- So two refund lines for one supplier, each individually under the ceiling but
-- JOINTLY over it, both classified `create_refund` and both were minted — the
-- supplier ending the run with more returned than it ever held. R600 and R600
-- against R1,000 is the whole defect. The per-line check cannot see it, because
-- neither line is wrong on its own; the PAIR is, which is the same shape as the
-- concurrency race the live path closes with a contact lock, arriving by a
-- different road.
--
-- ── THE FIX, AND WHY IT IS A WALK AND NOT A WINDOW ──────────────────────────
--
-- The run now decides a supplier's refunds IN ORDER — by date, then by bank
-- transaction id so the order is total and deterministic — carrying the credit
-- each accepted refund has consumed.
--
-- A running `SUM(...) OVER (... ROWS UNBOUNDED PRECEDING)` is the obvious
-- spelling and is WRONG: it counts refunds that were themselves refused. Given
-- R1,000 of credit and refunds of R900, R200, R100, the window makes the third
-- line's consumed total R1,100 and refuses it, when R100 of credit is plainly
-- still there. The error is in the safe direction, which is exactly why it
-- would have gone unnoticed — an operator sees a line reported instead of
-- minted and has no way to tell that the reason given is not the real one.
--
-- A RECURSIVE walk carries the consumed figure forward only for lines it
-- actually accepted, so the third line is admitted. It reads each row's OWN
-- `on_account_credit` at each step, which matters: two refunds on different
-- dates are measured against different balances, and only the part this run is
-- minting has to be subtracted by hand.
--
-- ── WHY A NEW MIGRATION AND NOT AN EDIT TO 682 ──────────────────────────────
--
-- 682 is applied on dev, on staging and on the schema fixture. An applied
-- migration is never edited: the tracking row carries its checksum, and a file
-- that changes underneath one is a database nobody can reason about. This
-- replaces ONLY the run function — the view, the credit function and the
-- constraints from 681 and 682 all stand unchanged.
--
-- ── NO DATA CHANGES ─────────────────────────────────────────────────────────

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
  -- ONE snapshot, and all four statements below read it. See 682: the payment
  -- arm's own mints raise a supplier's credit, so a refund arm re-evaluating
  -- the view between writes could mint a line the same batch had already logged
  -- over-ceiling.
  --
  -- DROP first: two calls in one transaction — which the integration suite
  -- makes, and an operator running two tenants back to back would — otherwise
  -- die on "relation already exists" before either has written anything.
  -- `pg_temp.` is spelled out because pg_temp is searched FIRST, and a function
  -- that writes financial documents must not take its input from a relation a
  -- caller can substitute.
  DROP TABLE IF EXISTS pg_temp.ap_pdb_run;
  CREATE TEMP TABLE ap_pdb_run ON COMMIT DROP AS
    SELECT * FROM ap_payment_document_backfill_candidates c
     WHERE p_company_id IS NULL OR c.company_id = p_company_id;

  -- ── 683: the cumulative ceiling ──────────────────────────────────────────
  --
  -- BEFORE the skip log, so a line demoted here is logged once, under the
  -- outcome it ends on. Walking each supplier's refunds in order and carrying
  -- only what was ACCEPTED — see the header for why the obvious window
  -- function is wrong.
  WITH RECURSIVE seq AS (
    SELECT r.bank_transaction_id, r.company_id, r.supplier_id, r.amount,
           r.on_account_credit,
           ROW_NUMBER() OVER (PARTITION BY r.company_id, r.supplier_id
                              ORDER BY r.transaction_date, r.bank_transaction_id) AS n
      FROM ap_pdb_run r
     WHERE r.outcome = 'create_refund'
  ),
  walk AS (
    SELECT s.bank_transaction_id, s.company_id, s.supplier_id, s.n,
           (s.amount <= s.on_account_credit) AS accepted,
           CASE WHEN s.amount <= s.on_account_credit THEN s.amount ELSE 0 END AS consumed
      FROM seq s
     WHERE s.n = 1
    UNION ALL
    SELECT s.bank_transaction_id, s.company_id, s.supplier_id, s.n,
           (s.amount <= s.on_account_credit - w.consumed) AS accepted,
           w.consumed
             + CASE WHEN s.amount <= s.on_account_credit - w.consumed THEN s.amount ELSE 0 END
      FROM walk w
      JOIN seq s
        ON s.company_id = w.company_id
       AND s.supplier_id = w.supplier_id
       AND s.n = w.n + 1
  )
  UPDATE ap_pdb_run r
     SET outcome = 'refund_exceeds_credit'
    FROM walk w
   WHERE r.bank_transaction_id = w.bank_transaction_id
     AND NOT w.accepted;

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
