-- Migration 615: the tooling to mint the supplier payment documents that
-- allocation never created, for bank lines already posted to the AP control
-- account. INSTALLS THE TOOLING; RUNS NOTHING.
--
-- ── WHAT IS MISSING FROM THE BOOKS ──────────────────────────────────────────
--
-- Until #340 (2026-09-08), `allocateTransaction` with `allocType='supplier'`
-- and no invoice named posted DR Accounts Payable / CR Bank and created NO
-- `supplier_payments` row. The control account moved; the subledger did not,
-- and nothing in the AP toolchain can see that cash, because every one of those
-- tools reads payment rows and there is no row to read. `list_unapplied_payments`
-- says so in its own description. On Velocity Fibre it is 634 bank lines worth
-- R34,736,869.40 — the bulk of the R36,281,750.22 by which the AP subledger
-- (R66,180,859.78) exceeds control account 2110 (R29,899,109.56), and the
-- reason aged_creditors carries R41.4m of 120+ debt for bills that were paid.
--
-- ── WHAT THE BACKFILL DOES, AND THE THREE THINGS IT MUST NOT DO ─────────────
--
-- It creates one `supplier_payments` row per qualifying bank line: status
-- `processed`, dated the bank line, for the full line amount, against the
-- supplier the allocation named, carrying the journal that allocation already
-- posted. That is the same document `recordSupplierBankPayment` writes on the
-- forward path, with the same columns and the same values, so a backfilled
-- payment and a new one are indistinguishable to every reader and to
-- `unwindBankAllocationApplication`, which finds both by `gl_journal_entry_id`.
--
--   1. IT POSTS NO JOURNAL. The DR AP / CR Bank entry exists and is correct.
--      A second one would double the debit and break the bank reconciliation.
--      This is a subledger-only backfill: nothing here writes to
--      gl_journal_entries or gl_journal_lines, and the control balance and
--      every bank reconciliation must be BIT-IDENTICAL after a run.
--   2. IT APPLIES THE PAYMENT TO NOTHING. `amount_paid` is not touched on any
--      bill and no `payment_allocations` row is written. Deciding which bill a
--      given payment settles is a judgement, made by a human or by
--      `apply_supplier_payment`, on cash this backfill has finally made
--      visible. Guessing here is the defect #340 deleted, not a fix for it.
--   3. IT INVENTS NOTHING. A line whose journal is not the two-legged DR AP /
--      CR Bank entry for exactly that amount, or whose supplier cannot be
--      resolved to exactly one live row, is REPORTED and skipped. It is never
--      approximated.
--
-- ── WHY THIS MIGRATION CHANGES NO DATA ──────────────────────────────────────
--
-- A migration runs on every environment at deploy time, unattended, with
-- nobody reading a diff. Minting 634 financial documents is not that kind of
-- change. So this file installs a VIEW that classifies every candidate line and
-- a FUNCTION that acts on it, and the run itself is a deliberate, per-company
-- act — `bun scripts/ap-backfill-supplier-payments.ts`, which reports the diff
-- inside a transaction and rolls back unless told to commit.
--
-- The view is also the answer to "would anything change if we ran it now",
-- available to anyone with a psql prompt, at any time, without running it.
--
-- ── IDEMPOTENT AND REVERSIBLE ───────────────────────────────────────────────
--
-- Idempotent: the view excludes any line that already has a payment document,
-- found EITHER by the journal it carries or by the bank transaction id in its
-- `reference` — which is what the forward path writes there and what this
-- backfill writes there. A second run classifies its own output as
-- `already_has_document` and creates nothing. A partial unique index on the
-- log makes that a constraint rather than a hope.
--
-- Reversible: every row created is recorded in `ap_payment_document_backfill`
-- under a batch id, and `ap_rollback_supplier_payment_document_backfill(batch)`
-- removes them wholesale. It REFUSES on any payment a human has since applied
-- or cancelled — rollback undoes this migration's work, never someone else's.

-- ── The audit and reversal log ──────────────────────────────────────────────
--
-- Skipped lines are recorded here too, with the reason. A backfill that silently
-- passes over a line whose supplier is missing leaves nobody anything to read;
-- this way the exceptions outlive the psql session that produced them.
CREATE TABLE IF NOT EXISTS ap_payment_document_backfill (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id            UUID NOT NULL,
  company_id          UUID NOT NULL REFERENCES companies(id),
  bank_transaction_id UUID NOT NULL REFERENCES bank_transactions(id),
  journal_entry_id    UUID,
  supplier_id         UUID,
  -- SET NULL rather than CASCADE: a rollback deletes the payment and the log
  -- row must survive to say that it did.
  supplier_payment_id UUID REFERENCES supplier_payments(id) ON DELETE SET NULL,
  amount              NUMERIC(15,2) NOT NULL,
  outcome             TEXT NOT NULL,
  reason              TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rolled_back_at      TIMESTAMPTZ,
  CONSTRAINT ap_pdb_outcome_chk CHECK (outcome IN ('created', 'skipped'))
);

CREATE INDEX IF NOT EXISTS idx_ap_pdb_batch
  ON ap_payment_document_backfill (batch_id);

CREATE INDEX IF NOT EXISTS idx_ap_pdb_company
  ON ap_payment_document_backfill (company_id, created_at DESC);

-- The hard floor under idempotency. One live created row per bank line, ever:
-- a second run that somehow passed the view's guards fails here rather than
-- minting a second document for cash that left the bank once.
--
-- `supplier_payment_id IS NOT NULL` is part of the predicate for a reason that
-- is not obvious. The FK above is ON DELETE SET NULL, so a payment DELETED
-- outside this migration's own rollback — by a DBA, by a future cleanup —
-- leaves the log row behind with its id nulled. Without this clause that
-- orphan still occupies the index while the view, seeing no payment, correctly
-- re-offers the line as `create`, and the next run dies on a duplicate-key
-- violation INSIDE the data-modifying CTE. That aborts the WHOLE run for the
-- tenant, not the one line, with an error naming an index rather than a cause.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ap_pdb_created_line
  ON ap_payment_document_backfill (bank_transaction_id)
  WHERE outcome = 'created' AND rolled_back_at IS NULL AND supplier_payment_id IS NOT NULL;

-- Tenant isolation. Shape copied verbatim from 596_gl_account_merges_rls.sql.
--
-- The FIRST lock on this table is that `app_user` holds no grant on it at all:
-- 348's blanket GRANT ran once over the tables that existed then, and its
-- ALTER DEFAULT PRIVILEGES only covers tables created by the role that set it.
-- The application never reads this table, so that is the correct posture and
-- an `app_user` SELECT is refused before RLS is consulted. The policy is the
-- SECOND lock, and it is the one that matters the day somebody re-runs a
-- blanket grant across the schema.
ALTER TABLE ap_payment_document_backfill ENABLE ROW LEVEL SECURITY;
ALTER TABLE ap_payment_document_backfill FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'ap_payment_document_backfill'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON ap_payment_document_backfill
      TO app_user
      USING (company_id IN (SELECT auth.user_companies()))
      WITH CHECK (company_id = app.current_company_id());
  END IF;
END $$;

-- ── The classification ──────────────────────────────────────────────────────
--
-- One row per money-out supplier-allocated bank line, with `outcome` saying
-- what a run would do with it and why. Reading this view is the dry run; it
-- writes nothing and can be run against production at any time.
--
-- The reason order is deliberate. `journal_shared_by_bank_lines` is tested
-- first because it invalidates the journal-based document test that follows
-- it; `already_has_document` is tested next, so a re-run reports its own
-- output as already done rather than re-examining journals for lines that are
-- finished.
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
    EXISTS (
      SELECT 1 FROM supplier_payments sp
       WHERE sp.company_id = resolved.company_id
         AND sp.status <> 'cancelled'
         AND (sp.gl_journal_entry_id = resolved.journal_entry_id
              OR sp.reference = resolved.bank_transaction_id::TEXT)
    )                                           AS has_document,
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
              OR sp.reference = resolved.bank_transaction_id::TEXT)
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

-- ── The run ─────────────────────────────────────────────────────────────────
--
-- `p_company_id` NULL means every company. Pass one in preference: this is a
-- per-tenant remedy and a per-tenant diff is one a person can actually read.
--
-- NOT `SECURITY DEFINER`. It is run by an operator through the backfill script
-- on an admin connection, never by the application on behalf of a tenant, and a
-- definer-rights function writing financial documents is a privilege escalation
-- waiting for a caller.
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
  -- SKIPS ARE LOGGED FIRST, and the order is load-bearing: after the INSERT
  -- below, this run's own creations would classify as `already_has_document`
  -- and be logged a second time as skipped.
  INSERT INTO ap_payment_document_backfill (
    batch_id, company_id, bank_transaction_id, journal_entry_id,
    supplier_id, supplier_payment_id, amount, outcome, reason
  )
  SELECT p_batch_id, c.company_id, c.bank_transaction_id, c.journal_entry_id,
         c.supplier_id, NULL, c.amount, 'skipped', c.outcome
  FROM ap_payment_document_backfill_candidates c
  WHERE c.outcome <> 'create'
    AND (p_company_id IS NULL OR c.company_id = p_company_id);

  -- The document, and only the document. No journal, no allocation, no
  -- `amount_paid`. Columns and values mirror `recordSupplierBankPayment`
  -- exactly, including `reference` = the bank transaction id, which is both the
  -- audit trail back to the line and half of this backfill's idempotency.
  --
  -- `created_by` is the journal's author: the person whose allocation posted
  -- this cash. It is uuid-typed and NOT NULL on both tables, so it needs no
  -- resolution — and attributing the document to whoever moved the money beats
  -- attributing it to whoever ran the backfill.
  --
  -- `payment_number` is left to trg_sp_payment_number, which is BEFORE INSERT
  -- FOR EACH ROW and therefore sees each preceding row of this statement.
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

  RETURN QUERY
  SELECT p_batch_id, l.outcome, l.reason, COUNT(*)::BIGINT, COALESCE(SUM(l.amount), 0)
  FROM ap_payment_document_backfill l
  WHERE l.batch_id = p_batch_id
  GROUP BY l.outcome, l.reason
  ORDER BY l.outcome, l.reason;
END;
$fn$;

-- ── The reversal ────────────────────────────────────────────────────────────
--
-- Wholesale, by batch. It REFUSES rather than partially undoes: a payment this
-- batch created that a human has since applied to a bill, or cancelled, is no
-- longer this batch's to delete, and deleting it would cascade
-- `payment_allocations` away and leave the bills it settled reading as open
-- again. Apply-then-rollback is a real sequence — the whole point of the
-- backfill is that these payments become applicable — so it is answered with an
-- error naming the payment rather than with data loss.
CREATE OR REPLACE FUNCTION ap_rollback_supplier_payment_document_backfill(
  p_batch_id UUID
)
RETURNS TABLE (
  deleted_count  BIGINT,
  deleted_amount NUMERIC
)
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_blocked TEXT;
BEGIN
  SELECT STRING_AGG(sp.id::TEXT, ', ')
    INTO v_blocked
  FROM ap_payment_document_backfill l
  JOIN supplier_payments sp ON sp.id = l.supplier_payment_id
  WHERE l.batch_id = p_batch_id
    AND l.outcome = 'created'
    AND l.rolled_back_at IS NULL
    AND (sp.status <> 'processed'
         OR EXISTS (SELECT 1 FROM payment_allocations pa WHERE pa.payment_id = sp.id)
         -- The legacy twin. Zero rows and no writer today (see the note in
         -- ap/unappliedPaymentService.ts), and it cascades on delete exactly
         -- like the live one — so a rollback that ignores it destroys those
         -- rows in silence the day anything starts writing them.
         OR EXISTS (SELECT 1 FROM supplier_payment_allocations spa WHERE spa.payment_id = sp.id));

  IF v_blocked IS NOT NULL THEN
    RAISE EXCEPTION
      'Rollback refused: payment(s) % have been applied or their status changed since the backfill. '
      'Reverse those applications first, or roll back the rest by hand.', v_blocked;
  END IF;

  -- Marked BEFORE the delete, in its own statement. Doing both in one
  -- data-modifying CTE has the FK's ON DELETE SET NULL trigger updating log
  -- rows the same command has already updated.
  UPDATE ap_payment_document_backfill l
     SET rolled_back_at = NOW()
   WHERE l.batch_id = p_batch_id
     AND l.outcome = 'created'
     AND l.rolled_back_at IS NULL
     AND l.supplier_payment_id IS NOT NULL;

  WITH gone AS (
    DELETE FROM supplier_payments sp
     USING ap_payment_document_backfill l
     WHERE l.batch_id = p_batch_id
       AND l.outcome = 'created'
       AND l.rolled_back_at IS NOT NULL
       AND sp.id = l.supplier_payment_id
    RETURNING sp.total_amount
  )
  SELECT COUNT(*)::BIGINT, COALESCE(SUM(gone.total_amount), 0)
    INTO deleted_count, deleted_amount
  FROM gone;

  RETURN NEXT;
END;
$fn$;
