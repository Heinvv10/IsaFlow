-- 891_supplier_credit_note_expense_accounts.sql
-- A SUPPLIER credit note reverses the bill it is linked to, on the bill's own accounts (Hein,
-- 2026-10-13). Until now approveCreditNote credited every supplier note's net to default_expense
-- (5100), whatever the bill had debited: Velocity Fibre re-pointed R8.54m of such credits off 5100
-- by journal on 13 Oct 2026. The posting rules live in
-- src/modules/accounting/services/ap/supplierCreditNoteExpenseLines.ts:
--
--  1. LINKED to a bill with a journal: the note credits that journal's expense / COS / asset legs
--     (every line but the AP and VAT ones) pro rata, on each leg's account, job, CC1, CC2 and BU,
--     each leg capped at what it still carries. What a note took per leg is recorded below, so a
--     second note on the bill cannot take the same leg again; a cancelled note's rows stop counting.
--     Notes approved before this migration recorded nothing; their amounts are replayed against the
--     legs, in approval order (the fallback for those notes only).
--  2. Whatever the legs cannot take (no bill, a bill with no journal, a bill already fully credited)
--     goes to the note's own account, `credit_notes.gl_account_id` (new, optional) ...
--  3. ... and, when the note names none, to default_expense, as before.
--
-- The AP debit and the single VAT credit are unchanged.
--
-- credit_notes.gl_account_id gets NO foreign key, as 874 left customer_invoice_items.gl_account_id:
-- an FK onto gl_accounts joins the account merge's catalogue sweep (gl/accountMergeReferences.ts).
-- It is checked against the chart by the bill-line rule (ap/billLineAccountGuard: this company's,
-- active, leaf, not AP/AR/bank/VAT/system) at create and again at approve, so a stale id fails
-- closed. A note's fields cannot be edited after create, so the approval digest needs no new
-- element: the column is fixed for the draft's whole life.
--
-- Rollback: DROP TABLE credit_note_expense_allocations; ALTER TABLE credit_notes DROP COLUMN
-- gl_account_id. Journals already posted keep the accounts they posted.
--
-- Locks: ADD COLUMN takes ACCESS EXCLUSIVE on credit_notes for a catalogue-only change (nullable,
-- no default). Bounded below.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.credit_notes ADD COLUMN IF NOT EXISTS gl_account_id UUID;

CREATE TABLE IF NOT EXISTS public.credit_note_expense_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id),
  credit_note_id UUID NOT NULL REFERENCES public.credit_notes(id) ON DELETE CASCADE,
  bill_id UUID NOT NULL REFERENCES public.supplier_invoices(id),
  journal_line_id UUID,
  gl_account_id UUID NOT NULL,
  project_id UUID,
  cc1_id UUID,
  cc2_id UUID,
  bu_id UUID,
  amount NUMERIC(15,2) NOT NULL,
  is_excess BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT credit_note_expense_allocations_leg_line
    CHECK (is_excess = (journal_line_id IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_credit_note_expense_allocations_bill
  ON public.credit_note_expense_allocations (company_id, bill_id);
CREATE INDEX IF NOT EXISTS idx_credit_note_expense_allocations_note
  ON public.credit_note_expense_allocations (company_id, credit_note_id);

ALTER TABLE public.credit_note_expense_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_note_expense_allocations FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'credit_note_expense_allocations'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON public.credit_note_expense_allocations
      TO app_user
      USING (company_id IN (SELECT auth.user_companies()))
      WITH CHECK (company_id = app.current_company_id());
  END IF;
END $$;

-- Rows are written once, at approval; nothing updates or deletes them (a cancel stops them counting).
GRANT SELECT, INSERT ON public.credit_note_expense_allocations TO app_user, platform_admin;
