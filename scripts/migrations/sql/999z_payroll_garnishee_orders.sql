-- 999z: garnishee orders (wave 6 GA). Court orders an employer must deduct from an employee's pay and hold for a creditor.
--
-- WHAT.
--   payroll_garnishee_orders  one row per order on an employee: kind (emolument_attachment = Magistrates' Courts Act
--     s65J; maintenance = Maintenance Act s28; administration = Magistrates' Courts Act s74), the court/case reference,
--     the creditor, the monthly instalment, the total debt and the balance still owed (both NULL for an open-ended
--     order, as most maintenance orders are), the dates it runs between, a priority, the GL liability its deductions
--     are credited to (payable_account_id: the company's garnishee payable), and a status:
--       active -> ended (a person ends it: reason and stamp) | satisfied (the balance reached nil at a run's approval)
--       satisfied -> active (the approval that satisfied it was reopened). An ended order keeps following the
--       approvals of runs that deducted before it ended (its balance), and never leaves 'ended'.
--   payroll_garnishee_deductions  what a pay run took for an order: the amount asked (min(instalment, balance)) and the
--     amount taken (after the s65J(1A)(a) 25% limit and the net pay left). Written when the run is calculated, replaced
--     on recalculation; balance_applied turns true when the run is approved (the order's balance falls by the amount)
--     and false again when it is reopened (the balance is restored). The balance is never touched at calculate.
--
-- INVARIANTS the triggers hold (INVOKER, so under the caller's RLS; ENABLE ALWAYS):
--   orders insert   the employee is this company's (an FK ignores RLS); created_by is the session user (auth.uid(),
--                   as 999h), never what the caller wrote; no session user is refused; status starts active and
--                   balance starts at total_debt.
--   orders update   the order's facts never change; balance always equals total_debt less the deductions applied to
--                   it, so a balance can be moved only by applying or restoring a deduction, never written freely;
--                   'ended' stamps ended_by / ended_at from the session and the clock; the end date and the end
--                   facts change only in the UPDATE that ends the order; satisfied means a balance of exactly nil.
--   deductions      insert: the order and the run are this company's, the employee is the order's, the run is not
--                   approved, paid or cancelled, and balance_applied starts false. Update: only balance_applied, true
--                   only while the run is approved, false only while it is not. Delete: only an unapplied deduction of
--                   a run that is not approved (recalculation replaces them).
--
-- NO CHART SEED (spec F13): the garnishee payable (a payroll_liability system account, "Garnishee Orders Payable") is
--   created by the GA service on a company's first order, in the order's transaction under the company's role-write
--   advisory lock (payrollGarnisheeAccount.ts), and every later order of the company names the same account. No definer
--   changes, no 930 row, no template or chart change for companies without garnishees.
--
-- OLD COLOUR: two new tables the previous release never writes. Its forward-compat guard (999a era, FQa
--   payrollRunKindGuard) already reads them by name through to_regclass: it refuses to calculate, approve or post a
--   run of an employee with an active order, and refuses every action (reopen included) on a run carrying deductions.
--   So a rollback to it never costs a garnishee as if it were not there and never reopens a run whose balances moved.
--
-- Rollback (down SQL; roll the code back first):
--   DROP TABLE IF EXISTS public.payroll_garnishee_deductions;
--   DROP TABLE IF EXISTS public.payroll_garnishee_orders;
--   DROP FUNCTION IF EXISTS public.payroll_garnishee_deductions_guard();
--   DROP FUNCTION IF EXISTS public.payroll_garnishee_orders_guard();
--   SELECT public.app_service_sync_policies();

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS public.payroll_garnishee_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id),
  employee_id UUID NOT NULL REFERENCES public.payroll_employees(id),
  kind TEXT NOT NULL CHECK (kind IN ('emolument_attachment', 'maintenance', 'administration')),
  reference TEXT NOT NULL CHECK (char_length(btrim(reference)) BETWEEN 1 AND 100),
  creditor_name TEXT NOT NULL CHECK (char_length(btrim(creditor_name)) BETWEEN 1 AND 200),
  instalment NUMERIC(14,2) NOT NULL CHECK (instalment > 0),
  total_debt NUMERIC(14,2) CHECK (total_debt > 0),
  balance NUMERIC(14,2) CHECK (balance >= 0),
  start_date DATE NOT NULL,
  end_date DATE,
  priority INTEGER NOT NULL DEFAULT 100 CHECK (priority BETWEEN 1 AND 9999),
  payable_account_id UUID NOT NULL REFERENCES public.gl_accounts(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended', 'satisfied')),
  end_reason TEXT,
  ended_by TEXT,
  ended_at TIMESTAMPTZ,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payroll_garnishee_orders_debt_and_balance CHECK ((total_debt IS NULL) = (balance IS NULL) AND (balance IS NULL OR balance <= total_debt)),
  CONSTRAINT payroll_garnishee_orders_dates CHECK (end_date IS NULL OR end_date >= start_date),
  CONSTRAINT payroll_garnishee_orders_ended CHECK ((status = 'ended') = (ended_by IS NOT NULL AND ended_at IS NOT NULL AND end_reason IS NOT NULL)),
  CONSTRAINT payroll_garnishee_orders_satisfied CHECK (status <> 'satisfied' OR (balance IS NOT NULL AND balance = 0))
);
COMMENT ON TABLE public.payroll_garnishee_orders IS
  'Garnishee orders on an employee (999z, wave 6 GA). balance = total_debt less the deductions applied at approval (trigger-held).';
CREATE INDEX IF NOT EXISTS payroll_garnishee_orders_company_employee ON public.payroll_garnishee_orders (company_id, employee_id);

CREATE TABLE IF NOT EXISTS public.payroll_garnishee_deductions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id),
  run_id UUID NOT NULL REFERENCES public.payroll_run_headers(id),
  order_id UUID NOT NULL REFERENCES public.payroll_garnishee_orders(id),
  employee_id UUID NOT NULL REFERENCES public.payroll_employees(id),
  requested NUMERIC(14,2) NOT NULL CHECK (requested > 0),
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0 AND amount <= requested),
  balance_applied BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payroll_garnishee_deductions_one_per_run UNIQUE (run_id, order_id)
);
COMMENT ON TABLE public.payroll_garnishee_deductions IS
  'What each pay run took for a garnishee order (999z, wave 6 GA). balance_applied: the run''s approval moved the order''s balance.';
CREATE INDEX IF NOT EXISTS payroll_garnishee_deductions_company_run ON public.payroll_garnishee_deductions (company_id, run_id);
CREATE INDEX IF NOT EXISTS payroll_garnishee_deductions_order ON public.payroll_garnishee_deductions (order_id);

CREATE OR REPLACE FUNCTION public.payroll_garnishee_orders_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  uid text := auth.uid();
  applied numeric;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF uid IS NULL THEN
      RAISE EXCEPTION 'payroll_garnishee_orders: an order needs a session user' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.payroll_employees e WHERE e.id = NEW.employee_id AND e.company_id = NEW.company_id) THEN
      RAISE EXCEPTION 'payroll_garnishee_orders: the employee is not this company''s' USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.gl_accounts a WHERE a.id = NEW.payable_account_id AND a.company_id = NEW.company_id
                     AND a.account_type = 'liability') THEN
      RAISE EXCEPTION 'payroll_garnishee_orders: the payable is not this company''s liability account' USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF NEW.status <> 'active' OR NEW.balance IS DISTINCT FROM NEW.total_debt OR NEW.ended_by IS NOT NULL THEN
      RAISE EXCEPTION 'payroll_garnishee_orders: a new order is active and owes its total debt' USING ERRCODE = 'check_violation';
    END IF;
    NEW.created_by := uid;
    NEW.created_at := clock_timestamp();
    NEW.updated_at := NEW.created_at;
    RETURN NEW;
  END IF;
  IF (NEW.company_id, NEW.employee_id, NEW.kind, NEW.reference, NEW.creditor_name, NEW.instalment, NEW.total_debt,
      NEW.start_date, NEW.priority, NEW.payable_account_id, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.company_id, OLD.employee_id, OLD.kind, OLD.reference, OLD.creditor_name, OLD.instalment, OLD.total_debt,
      OLD.start_date, OLD.priority, OLD.payable_account_id, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'payroll_garnishee_orders: an order''s facts never change; end it and enter a new one' USING ERRCODE = 'check_violation';
  END IF;
  -- An ended order stays ended; only its balance still follows the approvals of runs that deducted before it ended.
  IF OLD.status = 'ended' AND (NEW.status, NEW.end_date, NEW.end_reason, NEW.ended_by, NEW.ended_at)
       IS DISTINCT FROM (OLD.status, OLD.end_date, OLD.end_reason, OLD.ended_by, OLD.ended_at) THEN
    RAISE EXCEPTION 'payroll_garnishee_orders: an ended order is final' USING ERRCODE = 'check_violation';
  END IF;
  -- An order that is not ended keeps its end date and has no end facts: they are set only by the UPDATE that ends it.
  IF OLD.status <> 'ended' AND NEW.status <> 'ended' AND (NEW.end_date, NEW.end_reason, NEW.ended_by, NEW.ended_at)
       IS DISTINCT FROM (OLD.end_date, OLD.end_reason, OLD.ended_by, OLD.ended_at) THEN
    RAISE EXCEPTION 'payroll_garnishee_orders: an order''s end date changes only when it is ended' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.total_debt IS NOT NULL THEN
    SELECT COALESCE(sum(d.amount), 0) INTO applied FROM public.payroll_garnishee_deductions d
     WHERE d.order_id = NEW.id AND d.balance_applied;
    IF NEW.balance IS DISTINCT FROM NEW.total_debt - applied THEN
      RAISE EXCEPTION 'payroll_garnishee_orders: the balance is the total debt less the deductions applied (%)', NEW.total_debt - applied
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.status = 'ended' AND OLD.status <> 'ended' THEN
    IF uid IS NULL THEN
      RAISE EXCEPTION 'payroll_garnishee_orders: ending an order needs a session user' USING ERRCODE = '42501';
    END IF;
    NEW.ended_by := uid;
    NEW.ended_at := clock_timestamp();
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS payroll_garnishee_orders_guard ON public.payroll_garnishee_orders;
CREATE TRIGGER payroll_garnishee_orders_guard BEFORE INSERT OR UPDATE ON public.payroll_garnishee_orders
  FOR EACH ROW EXECUTE FUNCTION public.payroll_garnishee_orders_guard();
ALTER TABLE public.payroll_garnishee_orders ENABLE ALWAYS TRIGGER payroll_garnishee_orders_guard;

CREATE OR REPLACE FUNCTION public.payroll_garnishee_deductions_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  run_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT h.status INTO run_status FROM public.payroll_run_headers h WHERE h.id = OLD.run_id AND h.company_id = OLD.company_id;
  ELSE
    SELECT h.status INTO run_status FROM public.payroll_run_headers h WHERE h.id = NEW.run_id AND h.company_id = NEW.company_id;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payroll_garnishee_deductions: the run is not this company''s' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM public.payroll_garnishee_orders o
                    WHERE o.id = NEW.order_id AND o.company_id = NEW.company_id AND o.employee_id = NEW.employee_id) THEN
      RAISE EXCEPTION 'payroll_garnishee_deductions: the order is not this company''s employee''s' USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF run_status IN ('approved', 'paid', 'cancelled') OR NEW.balance_applied THEN
      RAISE EXCEPTION 'payroll_garnishee_deductions: a deduction is written unapplied, for a run being calculated' USING ERRCODE = 'check_violation';
    END IF;
    NEW.created_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.balance_applied OR run_status IN ('approved', 'paid') THEN
      RAISE EXCEPTION 'payroll_garnishee_deductions: an applied deduction, or one of an approved run, is never removed' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF (NEW.company_id, NEW.run_id, NEW.order_id, NEW.employee_id, NEW.requested, NEW.amount, NEW.created_at)
     IS DISTINCT FROM (OLD.company_id, OLD.run_id, OLD.order_id, OLD.employee_id, OLD.requested, OLD.amount, OLD.created_at)
     OR (NEW.balance_applied AND run_status <> 'approved')
     OR (NOT NEW.balance_applied AND run_status = 'approved') THEN
    RAISE EXCEPTION 'payroll_garnishee_deductions: only balance_applied changes: true at approval, false at reopen' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS payroll_garnishee_deductions_guard ON public.payroll_garnishee_deductions;
CREATE TRIGGER payroll_garnishee_deductions_guard BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_garnishee_deductions
  FOR EACH ROW EXECUTE FUNCTION public.payroll_garnishee_deductions_guard();
ALTER TABLE public.payroll_garnishee_deductions ENABLE ALWAYS TRIGGER payroll_garnishee_deductions_guard;

ALTER TABLE public.payroll_garnishee_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_garnishee_orders FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.payroll_garnishee_orders;
CREATE POLICY tenant_isolation ON public.payroll_garnishee_orders FOR ALL TO app_user
  USING (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()));
REVOKE ALL ON public.payroll_garnishee_orders FROM app_user;
GRANT SELECT ON public.payroll_garnishee_orders TO app_user;
GRANT INSERT (company_id, employee_id, kind, reference, creditor_name, instalment, total_debt, balance, start_date, end_date, priority,
  payable_account_id, created_by)
  ON public.payroll_garnishee_orders TO app_user;
GRANT UPDATE (balance, status, end_date, end_reason, ended_by, ended_at, updated_at) ON public.payroll_garnishee_orders TO app_user;

ALTER TABLE public.payroll_garnishee_deductions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_garnishee_deductions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.payroll_garnishee_deductions;
CREATE POLICY tenant_isolation ON public.payroll_garnishee_deductions FOR ALL TO app_user
  USING (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()));
REVOKE ALL ON public.payroll_garnishee_deductions FROM app_user;
GRANT SELECT, DELETE ON public.payroll_garnishee_deductions TO app_user;
GRANT INSERT (company_id, run_id, order_id, employee_id, requested, amount) ON public.payroll_garnishee_deductions TO app_user;
GRANT UPDATE (balance_applied) ON public.payroll_garnishee_deductions TO app_user;

SELECT public.app_service_sync_policies();
