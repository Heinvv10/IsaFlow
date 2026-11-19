-- 1012: correcting an off-cycle bonus amount (wave 6 OC, review #1620 final breaker delta M1 and L1). Expand-only.
--
-- WHAT.
--   payroll_off_cycle_employees.approved_amount / approved_as_of  the amount last approved on a run that was approved
--     and reopened: stamped by the guard at the first amount change after a reopen (approved_as_of = the run's
--     reopened_at). After a run's pay date its amounts were paid, so a correction may not raise one above it
--     (payrollOffCycleCorrection: refused at the amount edit and again at approval). NULL otherwise. app_user has no
--     grant on either column (999x grants UPDATE (amount) only), and the guard overwrites both on every UPDATE, so
--     only the guard writes them.
--   payroll_off_cycle_employees_guard (999x, replaced): an amount changes on a DRAFT bonus run only (999x allowed a
--     calculated one, whose lines were costed on the old amount: delta L1). The service sends the run back to draft and
--     clears its lines before it changes the amount. It stamps the two columns above; an INSERT leaves them NULL.
--     Still plpgsql SECURITY INVOKER (930's registry hashes definers only); the trigger itself (BEFORE INSERT OR
--     UPDATE, ENABLE ALWAYS) is 999x's, unchanged.
--
-- OLD COLOUR (the release before this one, 999x as merged):
--   Its amount edit updates the amount while the run is still calculated, then sends the run to draft. Against this
--   guard that edit is refused (check_violation, a 500) on a CALCULATED run until the new colour serves; on a draft
--   run it works. It never names the two new columns.
--
-- Rollback (down SQL; roll the code back first):
--   re-run 999x's payroll_off_cycle_employees_guard definition;
--   ALTER TABLE public.payroll_off_cycle_employees DROP COLUMN IF EXISTS approved_amount, DROP COLUMN IF EXISTS approved_as_of;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.payroll_off_cycle_employees
  ADD COLUMN IF NOT EXISTS approved_amount NUMERIC(14, 2) NULL,
  ADD COLUMN IF NOT EXISTS approved_as_of TIMESTAMPTZ NULL;

COMMENT ON COLUMN public.payroll_off_cycle_employees.approved_amount IS
  'The amount last approved on a reopened run (1012): stamped by payroll_off_cycle_employees_guard at the first amount change after a reopen. A paid run''s correction may not exceed it.';
COMMENT ON COLUMN public.payroll_off_cycle_employees.approved_as_of IS
  'The reopened_at of the reopen that approved_amount belongs to (1012).';

CREATE OR REPLACE FUNCTION public.payroll_off_cycle_employees_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  h record;
BEGIN
  SELECT run_kind, off_cycle_reason, status, reopened_at INTO h
    FROM public.payroll_run_headers WHERE id = NEW.run_id AND company_id = NEW.company_id;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.run_id IS DISTINCT FROM OLD.run_id
       OR NEW.employee_id IS DISTINCT FROM OLD.employee_id OR NEW.component_id IS DISTINCT FROM OLD.component_id THEN
      RAISE EXCEPTION 'payroll_off_cycle_employees: only the amount changes (same company, run, employee and earning)'
        USING ERRCODE = 'check_violation';
    END IF;
    -- Also held by the CHECK (amount > 0) and the NUMERIC(14, 2) column; stated here so the rule reads in one place.
    IF NEW.amount IS NULL OR NEW.amount <= 0 OR NEW.amount <> pg_catalog.round(NEW.amount, 2) THEN
      RAISE EXCEPTION 'payroll_off_cycle_employees: a bonus amount is more than R0, in whole cents' USING ERRCODE = 'check_violation';
    END IF;
    -- A draft only (delta L1): a calculated run's lines were costed on the old amount; the service sends the run back
    -- to draft and clears its lines before it changes an amount.
    IF NOT FOUND OR h.run_kind <> 'off_cycle' OR h.off_cycle_reason IS DISTINCT FROM 'bonus' OR h.status <> 'draft' THEN
      RAISE EXCEPTION 'payroll_off_cycle_employees: only a draft bonus run''s amount changes'
        USING ERRCODE = 'check_violation';
    END IF;
    -- The amount last approved (delta M1): the first change after a reopen keeps the amount it replaces.
    IF h.reopened_at IS NOT NULL AND OLD.approved_as_of IS DISTINCT FROM h.reopened_at THEN
      NEW.approved_amount := OLD.amount;
      NEW.approved_as_of := h.reopened_at;
    ELSE
      NEW.approved_amount := OLD.approved_amount;
      NEW.approved_as_of := OLD.approved_as_of;
    END IF;
    RETURN NEW;
  END IF;
  IF NOT FOUND OR h.run_kind <> 'off_cycle' OR h.status <> 'draft' THEN
    RAISE EXCEPTION 'payroll_off_cycle_employees: the run is not a draft off-cycle run of this company'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.payroll_employees e WHERE e.id = NEW.employee_id AND e.company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'payroll_off_cycle_employees: the employee is not this company''s' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF h.off_cycle_reason = 'bonus' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.payroll_components c
       WHERE c.id = NEW.component_id AND c.company_id = NEW.company_id AND c.component_type = 'earning'
         AND pg_catalog.btrim(c.sars_source_code) = '3605'
    ) THEN
      RAISE EXCEPTION 'payroll_off_cycle_employees: a bonus row names one of this company''s 3605 earnings'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.component_id IS NOT NULL THEN
    RAISE EXCEPTION 'payroll_off_cycle_employees: a termination row names no component' USING ERRCODE = 'check_violation';
  END IF;
  NEW.created_at := pg_catalog.clock_timestamp();
  NEW.approved_amount := NULL;
  NEW.approved_as_of := NULL;
  RETURN NEW;
END
$$;
