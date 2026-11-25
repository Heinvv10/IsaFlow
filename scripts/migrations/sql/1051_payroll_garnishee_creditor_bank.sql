-- 1051: the creditor's bank details on a garnishee order (master plan wave 7, GC1; W12 part 1; Hein's ruling 5).
--
-- WHAT. Five nullable columns on payroll_garnishee_orders: the account the creditor is paid into (holder, bank,
--   branch code, account number, account type), validated as payroll_bank_details' are (payrollBankDetailsService:
--   6-digit branch code, 6 to 16 digit account number, cheque / savings / transmission), all four required ones
--   together or none; the holder is optional, as on an employee. Two stamps, creditor_bank_set_by (TEXT, a user id)
--   and creditor_bank_set_at, written only by the trigger below from the session user and the clock.
--   creditor_entry_admin_only (boolean, default false): the durable fact "a pay run's approval has applied a
--   deduction of this order". Set true at that approval (the deferred trigger on payroll_garnishee_deductions below)
--   and never cleared, so a later reopen, recalculation or deletion of the deduction does not forget it (team review
--   #1895 B1). Backfilled here, failing closed: true for every order with a deduction applied or on a run that is or
--   ever was approved (approved / paid, approved_at, a journal, a reopen or an approval history).
--   GC2 (W12 part 2) pays these accounts from the salary bank file; nothing here touches the bank file or the ledger.
--
-- WHO (payroll_garnishee_creditor_bank_guard, INVOKER, ENABLE ALWAYS):
--   INSERT: an order is entered without creditor details, stamps or the flag; anything prefilled is refused, whoever
--     writes it (review B2: the column grant binds app_user only).
--   UPDATE that names a creditor column, a stamp or the flag: the flag is never cleared; the same details again keep the
--     stamps they had (a stamp is never written alone); otherwise a session user is required, details are replaced,
--     never removed, a change to details already entered is owner / admin only (the actor's role in the company, as
--     952's update policy), and the first entry is any payroll-detail role (the route's withPayrollDetailAccess) EXCEPT
--     on an order that is ended or carries the flag: there it is owner / admin only too, as an employee's first bank
--     details after an approved run (952, Hein's ruling on D1), because money already owed would follow that account.
--   The service decides the same before any write (a 4xx commits; a manager takes the company payroll-approval lock
--   first, so an approval in flight commits its flag before the verdict). The trigger is the floor for any other
--   writer; it takes no advisory lock (it runs after the row lock, so taking the approval lock there would reverse
--   approve's order: review A1). Its admin test reads company_users through auth.uid(), a claim set in the
--   transaction: a writer that can set claims can name any member (B3; a known platform limit, as 952).
--   app_user gets UPDATE on the five value columns and the flag (the deferred trigger sets it as the approver), never
--   on the stamps; INSERT is not widened.
--
-- The CHECK is added NOT VALID, then VALIDATEd in this file (the wave rule's pattern; in one transaction it gains
--   nothing over a plain ADD, review A2, and costs one scan of an all-NULL column set).
--
-- PII. The numbers are stored in full (GC2 needs them); the API masks them (account number to its last four, branch
--   code to its last two, holder to its first letter, as an employee's), a full read is owner / admin only and is
--   recorded in audit_log (action export) in the read's transaction, and the change's audit row holds masked values and
--   the names of the fields that changed. No log line carries a value.
--
-- OLD COLOUR: the previous release never names these columns. Its INSERT lists its columns (they default NULL / false,
--   so the INSERT arm passes), its end-order UPDATE sets none of them (so the UPDATE arm does not fire), and its reads
--   map named fields (SELECT o.* / RETURNING * carry the extra columns, which mapOrder ignores). Its approval sets
--   balance_applied as before; the deferred trigger then sets the flag at its commit, after settleBalances has moved
--   the balance, so 999z's balance check holds. 999z's guards are unchanged. No definer is created or changed: no 930 row.
--
-- Rollback (down SQL; roll the code back first):
--   DROP TRIGGER IF EXISTS payroll_garnishee_creditor_entry_flag ON public.payroll_garnishee_deductions;
--   DROP FUNCTION IF EXISTS public.payroll_garnishee_creditor_entry_flag();
--   DROP TRIGGER IF EXISTS payroll_garnishee_creditor_bank_guard ON public.payroll_garnishee_orders;
--   DROP FUNCTION IF EXISTS public.payroll_garnishee_creditor_bank_guard();
--   ALTER TABLE public.payroll_garnishee_orders DROP COLUMN IF EXISTS creditor_account_holder, ... (all eight);

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.payroll_garnishee_orders
  ADD COLUMN IF NOT EXISTS creditor_account_holder TEXT,
  ADD COLUMN IF NOT EXISTS creditor_bank_name TEXT,
  ADD COLUMN IF NOT EXISTS creditor_branch_code TEXT,
  ADD COLUMN IF NOT EXISTS creditor_account_number TEXT,
  ADD COLUMN IF NOT EXISTS creditor_account_type TEXT,
  ADD COLUMN IF NOT EXISTS creditor_bank_set_by TEXT,
  ADD COLUMN IF NOT EXISTS creditor_bank_set_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS creditor_entry_admin_only BOOLEAN NOT NULL DEFAULT false;

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

-- Backfill (before the guard exists; 999z's guard passes a flag-only UPDATE): every company's orders, each by its own
-- deductions, no literal company_id. Deterministic and fail-closed.
UPDATE public.payroll_garnishee_orders o SET creditor_entry_admin_only = true
 WHERE NOT o.creditor_entry_admin_only
   AND EXISTS (SELECT 1 FROM public.payroll_garnishee_deductions d
                 JOIN public.payroll_run_headers h ON h.id = d.run_id AND h.company_id = d.company_id
                WHERE d.order_id = o.id AND d.company_id = o.company_id
                  AND (d.balance_applied OR h.status IN ('approved', 'paid') OR h.approved_at IS NOT NULL
                       OR h.journal_entry_id IS NOT NULL OR h.reopened_at IS NOT NULL
                       OR NOT isempty(COALESCE(h.approval_history, '{}'))));

CREATE OR REPLACE FUNCTION public.payroll_garnishee_creditor_bank_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  uid text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF pg_catalog.num_nonnulls(NEW.creditor_account_holder, NEW.creditor_bank_name, NEW.creditor_branch_code, NEW.creditor_account_number,
                               NEW.creditor_account_type, NEW.creditor_bank_set_by, NEW.creditor_bank_set_at) > 0
       OR NEW.creditor_entry_admin_only THEN
      RAISE EXCEPTION 'payroll_garnishee_orders: an order is entered without creditor bank details; enter them on the order'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.creditor_entry_admin_only AND NOT NEW.creditor_entry_admin_only THEN
    RAISE EXCEPTION 'payroll_garnishee_orders: creditor_entry_admin_only is never cleared' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.creditor_account_holder, NEW.creditor_bank_name, NEW.creditor_branch_code, NEW.creditor_account_number, NEW.creditor_account_type)
     IS NOT DISTINCT FROM (OLD.creditor_account_holder, OLD.creditor_bank_name, OLD.creditor_branch_code, OLD.creditor_account_number, OLD.creditor_account_type) THEN
    NEW.creditor_bank_set_by := OLD.creditor_bank_set_by;
    NEW.creditor_bank_set_at := OLD.creditor_bank_set_at;
    RETURN NEW;
  END IF;
  uid := auth.uid();
  IF uid IS NULL THEN
    RAISE EXCEPTION 'payroll_garnishee_orders: creditor bank details need a session user' USING ERRCODE = '42501';
  END IF;
  IF OLD.creditor_account_number IS NOT NULL AND NEW.creditor_account_number IS NULL THEN
    RAISE EXCEPTION 'payroll_garnishee_orders: creditor bank details are replaced, never removed' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT COALESCE(public.company_member_actor_role(NEW.company_id) IN ('owner', 'admin'), false) THEN
    IF OLD.creditor_account_number IS NOT NULL THEN
      RAISE EXCEPTION 'payroll_garnishee_orders: only an owner or admin changes creditor bank details' USING ERRCODE = '42501';
    END IF;
    IF OLD.status = 'ended' OR OLD.creditor_entry_admin_only OR NEW.creditor_entry_admin_only THEN
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
  BEFORE INSERT OR UPDATE OF creditor_account_holder, creditor_bank_name, creditor_branch_code, creditor_account_number,
                   creditor_account_type, creditor_bank_set_by, creditor_bank_set_at, creditor_entry_admin_only
  ON public.payroll_garnishee_orders
  FOR EACH ROW EXECUTE FUNCTION public.payroll_garnishee_creditor_bank_guard();
ALTER TABLE public.payroll_garnishee_orders ENABLE ALWAYS TRIGGER payroll_garnishee_creditor_bank_guard;

-- The flag, set when an approval applies a deduction (applyRunGarnishees: balance_applied false -> true). DEFERRED to
-- the commit: the approval moves the order's balance (settleBalances) after the deductions, and 999z's guard checks
-- balance = total_debt - applied on every order UPDATE, so writing the order any earlier would be refused.
CREATE OR REPLACE FUNCTION public.payroll_garnishee_creditor_entry_flag() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  UPDATE public.payroll_garnishee_orders SET creditor_entry_admin_only = true
   WHERE id = NEW.order_id AND company_id = NEW.company_id AND NOT creditor_entry_admin_only;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS payroll_garnishee_creditor_entry_flag ON public.payroll_garnishee_deductions;
CREATE CONSTRAINT TRIGGER payroll_garnishee_creditor_entry_flag
  AFTER UPDATE OF balance_applied ON public.payroll_garnishee_deductions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.balance_applied AND NOT OLD.balance_applied)
  EXECUTE FUNCTION public.payroll_garnishee_creditor_entry_flag();
ALTER TABLE public.payroll_garnishee_deductions ENABLE ALWAYS TRIGGER payroll_garnishee_creditor_entry_flag;

GRANT UPDATE (creditor_account_holder, creditor_bank_name, creditor_branch_code, creditor_account_number, creditor_account_type,
  creditor_entry_admin_only)
  ON public.payroll_garnishee_orders TO app_user;
