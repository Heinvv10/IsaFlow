-- 1051: the creditor's bank details on a garnishee order (master plan wave 7, GC1; W12 part 1; Hein's ruling 5).
--
-- WHAT. Five nullable columns on payroll_garnishee_orders: the account the creditor is paid into (holder, bank,
--   branch code, account number, account type), validated as payroll_bank_details' are (payrollBankDetailsService:
--   6-digit branch code, 6 to 16 digit account number, cheque / savings / transmission), all four required ones
--   together or none; the holder is optional, as on an employee. Two stamps, creditor_bank_set_by (TEXT, a user id)
--   and creditor_bank_set_at, written only by the trigger below from the session user and the clock.
--   GC2 (W12 part 2) pays these accounts from the salary bank file; nothing here touches the bank file or the ledger.
--
-- WHO (payroll_garnishee_creditor_bank_guard, INVOKER, ENABLE ALWAYS, fires only on an UPDATE that names a creditor
--   column): a session user is required; a change to details already entered is owner / admin only (the actor's role
--   in the company, as 952's update policy); the first entry is any payroll-detail role (the route's
--   withPayrollDetailAccess) EXCEPT on an order that is ended or that a run which is or ever was approved has deducted
--   (a deduction applied, or on a run approved / paid / with approved_at, a journal, a reopen or an approval history,
--   or a balance below the total debt): there the first entry is owner / admin only too, as an employee's first bank
--   details after an approved run (952, Hein's ruling on D1), because money already owed would follow that account.
--   For that verdict a non-admin first entry takes the company payroll-approval lock (as 999z's insert and end do).
--   Details are replaced, never removed. The service decides the same before any write (a 4xx commits); the trigger
--   is the floor for any other writer.
--   app_user gets UPDATE on the five columns only; INSERT is not widened (an order is entered without them).
--
-- CHECKs are added NOT VALID, then VALIDATEd in this file: every existing row has NULLs, so the scan passes.
--
-- PII. The numbers are stored in full (GC2 needs them); the API masks them (account number to its last four, branch
--   code to its last two, holder to its first letter, as an employee's), a full read is owner / admin only and is
--   recorded in audit_log (action export) in the read's transaction, and the change's audit row holds masked values only.
--   No log line carries a value.
--
-- OLD COLOUR: the previous release never names these columns. Its INSERT lists its columns (they default NULL), its
--   end-order UPDATE sets none of them (so the new trigger, UPDATE OF those columns, does not fire for it), and its
--   reads map named fields (SELECT o.* / RETURNING * carry the extra columns, which mapOrder ignores). 999z's guard
--   is unchanged: its facts tuple does not include the new columns, so it neither refuses nor stamps them.
--   No definer is created or changed: no 930 row.
--
-- Rollback (down SQL; roll the code back first):
--   DROP TRIGGER IF EXISTS payroll_garnishee_creditor_bank_guard ON public.payroll_garnishee_orders;
--   DROP FUNCTION IF EXISTS public.payroll_garnishee_creditor_bank_guard();
--   ALTER TABLE public.payroll_garnishee_orders DROP COLUMN IF EXISTS creditor_account_holder, ... (all seven);

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.payroll_garnishee_orders
  ADD COLUMN IF NOT EXISTS creditor_account_holder TEXT,
  ADD COLUMN IF NOT EXISTS creditor_bank_name TEXT,
  ADD COLUMN IF NOT EXISTS creditor_branch_code TEXT,
  ADD COLUMN IF NOT EXISTS creditor_account_number TEXT,
  ADD COLUMN IF NOT EXISTS creditor_account_type TEXT,
  ADD COLUMN IF NOT EXISTS creditor_bank_set_by TEXT,
  ADD COLUMN IF NOT EXISTS creditor_bank_set_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public.payroll_garnishee_orders'::pg_catalog.regclass
                   AND conname = 'payroll_garnishee_orders_creditor_bank') THEN
    ALTER TABLE public.payroll_garnishee_orders ADD CONSTRAINT payroll_garnishee_orders_creditor_bank CHECK (
      pg_catalog.num_nulls(creditor_bank_name, creditor_branch_code, creditor_account_number, creditor_account_type,
                           creditor_bank_set_by, creditor_bank_set_at) IN (0, 6)
      AND (creditor_account_holder IS NULL OR creditor_account_number IS NOT NULL)
      AND (creditor_bank_name IS NULL OR pg_catalog.char_length(pg_catalog.btrim(creditor_bank_name)) BETWEEN 1 AND 100)
      AND (creditor_branch_code IS NULL OR creditor_branch_code ~ '^[0-9]{6}$')
      AND (creditor_account_number IS NULL OR creditor_account_number ~ '^[0-9]{6,16}$')
      AND (creditor_account_type IS NULL OR creditor_account_type IN ('cheque', 'savings', 'transmission'))
      AND (creditor_account_holder IS NULL OR pg_catalog.char_length(pg_catalog.btrim(creditor_account_holder)) BETWEEN 1 AND 100)
    ) NOT VALID;
  END IF;
END $$;
ALTER TABLE public.payroll_garnishee_orders VALIDATE CONSTRAINT payroll_garnishee_orders_creditor_bank;

CREATE OR REPLACE FUNCTION public.payroll_garnishee_creditor_bank_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  uid text := auth.uid();
  is_admin boolean;
BEGIN
  IF (NEW.creditor_account_holder, NEW.creditor_bank_name, NEW.creditor_branch_code, NEW.creditor_account_number, NEW.creditor_account_type)
     IS NOT DISTINCT FROM (OLD.creditor_account_holder, OLD.creditor_bank_name, OLD.creditor_branch_code, OLD.creditor_account_number, OLD.creditor_account_type) THEN
    NEW.creditor_bank_set_by := OLD.creditor_bank_set_by;
    NEW.creditor_bank_set_at := OLD.creditor_bank_set_at;
    RETURN NEW;
  END IF;
  IF uid IS NULL THEN
    RAISE EXCEPTION 'payroll_garnishee_orders: creditor bank details need a session user' USING ERRCODE = '42501';
  END IF;
  is_admin := COALESCE(public.company_member_actor_role(NEW.company_id) IN ('owner', 'admin'), false);
  IF OLD.creditor_account_number IS NOT NULL THEN
    IF NEW.creditor_account_number IS NULL THEN
      RAISE EXCEPTION 'payroll_garnishee_orders: creditor bank details are replaced, never removed' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT is_admin THEN
      RAISE EXCEPTION 'payroll_garnishee_orders: only an owner or admin changes creditor bank details' USING ERRCODE = '42501';
    END IF;
  ELSIF NOT is_admin THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('payroll_approval:' || NEW.company_id::text, 0));
    IF OLD.status = 'ended' OR OLD.balance IS DISTINCT FROM OLD.total_debt OR EXISTS (
         SELECT 1 FROM public.payroll_garnishee_deductions d
           JOIN public.payroll_run_headers h ON h.id = d.run_id AND h.company_id = d.company_id
          WHERE d.order_id = OLD.id AND d.company_id = OLD.company_id
            AND (d.balance_applied OR h.status IN ('approved', 'paid') OR h.approved_at IS NOT NULL
                 OR h.journal_entry_id IS NOT NULL OR h.reopened_at IS NOT NULL
                 OR NOT isempty(COALESCE(h.approval_history, '{}')))) THEN
      RAISE EXCEPTION 'payroll_garnishee_orders: only an owner or admin enters creditor bank details on an ended or approved-deducted order'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  NEW.creditor_bank_set_by := uid;
  NEW.creditor_bank_set_at := pg_catalog.clock_timestamp();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS payroll_garnishee_creditor_bank_guard ON public.payroll_garnishee_orders;
CREATE TRIGGER payroll_garnishee_creditor_bank_guard
  BEFORE UPDATE OF creditor_account_holder, creditor_bank_name, creditor_branch_code, creditor_account_number,
                   creditor_account_type, creditor_bank_set_by, creditor_bank_set_at
  ON public.payroll_garnishee_orders
  FOR EACH ROW EXECUTE FUNCTION public.payroll_garnishee_creditor_bank_guard();
ALTER TABLE public.payroll_garnishee_orders ENABLE ALWAYS TRIGGER payroll_garnishee_creditor_bank_guard;

GRANT UPDATE (creditor_account_holder, creditor_bank_name, creditor_branch_code, creditor_account_number, creditor_account_type)
  ON public.payroll_garnishee_orders TO app_user;
