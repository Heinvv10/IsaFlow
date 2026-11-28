-- 1057: garnishee creditors paid from the salary bank file (master plan wave 7, GC2; W12 part 2; Hein's ruling 5, grill F13).
--
-- WHAT.
--   payroll_bank_file_items.garnishee_order_id  NULL = what the file paid an EMPLOYEE (999h, unchanged); set = what it
--     paid the CREDITOR of that garnishee order out of that employee's deduction on the file's run. employee_id stays NOT
--     NULL on a creditor line (the employee whose pay the deduction came from).
--   The creditor's account AS PAID (creditor_account_holder, _bank_name, _branch_code, _account_number, _account_type)
--     and the order's creditor_bank_set_at when the file was built (the version token, GC1 design input): the order row
--     keeps no history of its details, so the file's own record of where the money went lives here. All set on a
--     creditor line (the holder may be NULL, as on the order), all NULL on an employee line (CHECK, NOT VALID then
--     VALIDATE).
--   Uniqueness: one employee line per (file, employee) and one creditor line per (file, order), as partial unique
--     indexes created BEFORE 999h's payroll_bank_file_items_one_per_employee is dropped (an employee can have both a net
--     pay line and creditor lines in one file).
--   payroll_bank_file_items_guard (replaced): an employee line exactly as 999h. A creditor line names this company's
--     order, an applied deduction (balance_applied) of that order on the file's run for that employee, pays exactly that
--     deduction, and carries the order's CURRENT creditor details and creditor_bank_set_at: a forged or stale snapshot
--     is refused at the insert, whoever writes it.
--   payroll_bank_files.creditor_journal_id  the journal that clears the garnishee payable when the bank's acceptance is
--     recorded (confirm): DR each payable, CR the account the run's net pay was credited to. Unique: one per file.
--   payroll_bank_files_guard (replaced; 999h's rules kept word for word): an insert and a void carry no journal; a
--     confirm of a file WITH creditor lines must name a POSTED journal of this company whose source_record_id is the file
--     and whose debits equal the file's creditor lines; a confirm of a file without creditor lines names none. So a
--     confirm that skips the creditor journal (the old colour's confirm of a new file) is refused, never half-recorded.
--
--   payroll_garnishee_order_counted + 999z's payroll_garnishee_orders_guard (balance line only): an order's balance is
--     total_debt less, per run, the GREATER of its applied deduction and what a confirmed file paid its creditor.
--
-- No SECURITY DEFINER is created or changed (every function here is INVOKER): no 930 row.
--
-- OLD COLOUR (the release before GC2, running beside this schema):
--   generate  inserts employee items naming (company_id, file_id, employee_id, amount_cents): garnishee_order_id and the
--             snapshot default NULL, the CHECK holds, the employee arm of the guard is 999h's, and the employee partial
--             unique index keeps one line per employee. Its file insert names no creditor_journal_id (NULL, allowed).
--   confirm   of a file it made (no creditor lines): allowed, as before. Of a file the NEW release made with creditor
--             lines: refused by the guard (no journal), so the payable is never left open behind a confirmed file; the
--             new colour confirms it.
--   reopen / approve of a run whose order has a confirmed creditor line its approval no longer applies: the old
--             colour's settleBalances writes total_debt - applied, which the replaced guard refuses (a 500, rolled back):
--             fail closed, never a balance that forgets a payment. Orders without confirmed creditor lines: counted = applied,
--             so the old colour's balances still pass.
--   settlement / status reads  read payroll_bank_file_items by employee_id and would count a new file's creditor lines
--             as paid to the employee: only for a file the new release made, and only while both colours serve.
--
-- Rollback (down SQL; roll the code back first; refused while any creditor line exists, as it should be):
--   restore 999z's payroll_garnishee_orders_guard body; DROP FUNCTION IF EXISTS public.payroll_garnishee_order_counted(uuid);
--   restore 999h's payroll_bank_files_guard and payroll_bank_file_items_guard bodies;
--   ALTER TABLE public.payroll_bank_file_items ADD CONSTRAINT payroll_bank_file_items_one_per_employee UNIQUE (file_id, employee_id);
--   DROP INDEX IF EXISTS public.payroll_bank_file_items_employee_line, public.payroll_bank_file_items_creditor_line,
--     public.payroll_bank_file_items_garnishee_order,
--     public.payroll_bank_files_one_creditor_journal;
--   ALTER TABLE public.payroll_bank_file_items DROP CONSTRAINT IF EXISTS payroll_bank_file_items_creditor_snapshot,
--     DROP COLUMN IF EXISTS garnishee_order_id, ... (the six snapshot columns);
--   ALTER TABLE public.payroll_bank_files DROP COLUMN IF EXISTS creditor_journal_id;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.payroll_bank_file_items
  ADD COLUMN IF NOT EXISTS garnishee_order_id UUID,
  ADD COLUMN IF NOT EXISTS creditor_account_holder TEXT,
  ADD COLUMN IF NOT EXISTS creditor_bank_name TEXT,
  ADD COLUMN IF NOT EXISTS creditor_branch_code TEXT,
  ADD COLUMN IF NOT EXISTS creditor_account_number TEXT,
  ADD COLUMN IF NOT EXISTS creditor_account_type TEXT,
  ADD COLUMN IF NOT EXISTS creditor_bank_set_at TIMESTAMPTZ;
ALTER TABLE public.payroll_bank_files ADD COLUMN IF NOT EXISTS creditor_journal_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public.payroll_bank_file_items'::pg_catalog.regclass
                   AND conname = 'payroll_bank_file_items_garnishee_order_fkey') THEN
    ALTER TABLE public.payroll_bank_file_items ADD CONSTRAINT payroll_bank_file_items_garnishee_order_fkey
      FOREIGN KEY (garnishee_order_id) REFERENCES public.payroll_garnishee_orders(id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public.payroll_bank_file_items'::pg_catalog.regclass
                   AND conname = 'payroll_bank_file_items_creditor_snapshot') THEN
    ALTER TABLE public.payroll_bank_file_items ADD CONSTRAINT payroll_bank_file_items_creditor_snapshot CHECK (
      CASE WHEN garnishee_order_id IS NULL
        THEN pg_catalog.num_nonnulls(creditor_account_holder, creditor_bank_name, creditor_branch_code, creditor_account_number,
                                     creditor_account_type, creditor_bank_set_at) = 0
        ELSE pg_catalog.num_nulls(creditor_bank_name, creditor_branch_code, creditor_account_number, creditor_account_type,
                                  creditor_bank_set_at) = 0
      END) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public.payroll_bank_files'::pg_catalog.regclass
                   AND conname = 'payroll_bank_files_creditor_journal_fkey') THEN
    ALTER TABLE public.payroll_bank_files ADD CONSTRAINT payroll_bank_files_creditor_journal_fkey
      FOREIGN KEY (creditor_journal_id) REFERENCES public.gl_journal_entries(id) NOT VALID;
  END IF;
END $$;
-- Every existing row has the new columns NULL: each VALIDATE scans the (small) table and passes.
ALTER TABLE public.payroll_bank_file_items VALIDATE CONSTRAINT payroll_bank_file_items_garnishee_order_fkey;
ALTER TABLE public.payroll_bank_file_items VALIDATE CONSTRAINT payroll_bank_file_items_creditor_snapshot;
ALTER TABLE public.payroll_bank_files VALIDATE CONSTRAINT payroll_bank_files_creditor_journal_fkey;

CREATE UNIQUE INDEX IF NOT EXISTS payroll_bank_files_one_creditor_journal
  ON public.payroll_bank_files (creditor_journal_id) WHERE creditor_journal_id IS NOT NULL;

-- The two partial uniques first, then 999h's whole-table one goes (so no instant is without a per-employee unique).
CREATE UNIQUE INDEX IF NOT EXISTS payroll_bank_file_items_employee_line
  ON public.payroll_bank_file_items (file_id, employee_id) WHERE garnishee_order_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS payroll_bank_file_items_creditor_line
  ON public.payroll_bank_file_items (file_id, garnishee_order_id) WHERE garnishee_order_id IS NOT NULL;
ALTER TABLE public.payroll_bank_file_items DROP CONSTRAINT IF EXISTS payroll_bank_file_items_one_per_employee;
-- The FK's own index: the re-approval guard and the confirm read creditor lines by order.
CREATE INDEX IF NOT EXISTS payroll_bank_file_items_garnishee_order ON public.payroll_bank_file_items (garnishee_order_id)
  WHERE garnishee_order_id IS NOT NULL;

COMMENT ON COLUMN public.payroll_bank_file_items.garnishee_order_id IS
  'NULL: the file paid the employee their net (999h). Set: it paid this garnishee order''s creditor the employee''s deduction (1057, GC2).';
COMMENT ON COLUMN public.payroll_bank_file_items.creditor_bank_set_at IS
  'The order''s creditor_bank_set_at when the file was built: confirm refuses (or needs an attestation) when the order''s details changed since.';
COMMENT ON COLUMN public.payroll_bank_files.creditor_journal_id IS
  'The journal confirm posted to clear the garnishee payable for the file''s creditor lines (1057, GC2). NULL when the file has none.';

CREATE OR REPLACE FUNCTION public.payroll_bank_file_items_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  f record;
BEGIN
  -- No UPDATE for anyone. DELETE is not granted to app_user (only an owner tidying a disposable database removes rows).
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'payroll_bank_file_items: an item is never changed' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  SELECT status, run_id INTO f FROM public.payroll_bank_files WHERE id = NEW.file_id AND company_id = NEW.company_id;
  IF NOT FOUND OR f.status <> 'generated' THEN
    RAISE EXCEPTION 'payroll_bank_file_items: items belong to a generated file of this company'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.garnishee_order_id IS NOT NULL THEN
    -- 1057: a creditor line pays exactly an applied deduction of this company's order, on the file's run, from this
    -- employee's pay, into the account the order names NOW (and records the details' version).
    IF NOT EXISTS (
      SELECT 1 FROM public.payroll_garnishee_deductions d
        JOIN public.payroll_garnishee_orders o ON o.id = d.order_id AND o.company_id = d.company_id
       WHERE d.run_id = f.run_id AND d.order_id = NEW.garnishee_order_id AND d.company_id = NEW.company_id
         AND d.employee_id = NEW.employee_id AND o.employee_id = NEW.employee_id AND d.balance_applied
         AND round(d.amount * 100)::bigint = NEW.amount_cents
         AND o.creditor_account_number IS NOT NULL
         AND (o.creditor_account_holder, o.creditor_bank_name, o.creditor_branch_code, o.creditor_account_number,
              o.creditor_account_type, o.creditor_bank_set_at)
             IS NOT DISTINCT FROM (NEW.creditor_account_holder, NEW.creditor_bank_name, NEW.creditor_branch_code,
              NEW.creditor_account_number, NEW.creditor_account_type, NEW.creditor_bank_set_at)
    ) THEN
      RAISE EXCEPTION 'payroll_bank_file_items: a creditor line pays exactly an applied garnishee deduction on the file''s run, into the order''s current creditor account'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- F-2 / F-3 (review #1524 round 4): the employee is this company's (FKs ignore RLS), has a line on the file's run, and
  -- the item pays exactly that line's net: no item for another tenant's employee, one off the run, or a redistribution.
  IF NOT EXISTS (
    SELECT 1 FROM public.payroll_employees e
      JOIN public.payroll_run_lines l ON l.employee_id = e.id AND l.run_id = f.run_id
     WHERE e.id = NEW.employee_id AND e.company_id = NEW.company_id
       AND round(l.net_pay * 100)::bigint = NEW.amount_cents
  ) THEN
    RAISE EXCEPTION 'payroll_bank_file_items: an item pays this company''s employee exactly their net on the file''s run'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.payroll_bank_files_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  uid text := auth.uid();
  h record;
  creditor_cents bigint;
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'payroll_bank_files: a bank-file write needs a session user' USING ERRCODE = '42501';
  END IF;
  SELECT status, COALESCE(approved_at, approval_grandfathered_at) AS final_at, approval_history
    INTO h FROM public.payroll_run_headers WHERE id = NEW.run_id AND company_id = NEW.company_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payroll_bank_files: the run is not this company''s' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'generated' OR h.status <> 'approved' OR h.final_at IS NULL OR NEW.run_approved_at IS DISTINCT FROM h.final_at THEN
      RAISE EXCEPTION 'payroll_bank_files: a file is recorded as generated, for an approved run, at its current approval'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.creditor_journal_id IS NOT NULL THEN
      RAISE EXCEPTION 'payroll_bank_files: a new file has no creditor journal (confirm posts it)' USING ERRCODE = 'check_violation';
    END IF;
    NEW.created_by := uid;
    NEW.created_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF OLD.status <> 'generated' OR NEW.status NOT IN ('confirmed', 'voided')
     OR (NEW.company_id, NEW.run_id, NEW.format, NEW.layout, NEW.sha256, NEW.line_count, NEW.total_cents,
         NEW.action_date, NEW.run_approved_at, NEW.created_by, NEW.created_at)
        IS DISTINCT FROM (OLD.company_id, OLD.run_id, OLD.format, OLD.layout, OLD.sha256, OLD.line_count, OLD.total_cents,
         OLD.action_date, OLD.run_approved_at, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'payroll_bank_files: only a generated file may be confirmed or voided, and its facts never change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'confirmed' THEN
    -- NULL-safe both ways: a NULL final_at, history or run_approved_at must refuse, never pass as an unknown.
    IF NOT (COALESCE(NEW.run_approved_at = h.final_at, false) OR COALESCE(h.approval_history @> NEW.run_approved_at, false)) THEN
      RAISE EXCEPTION 'payroll_bank_files: the file pays an approval this run never had' USING ERRCODE = 'check_violation';
    END IF;
    -- 1057: a file that paid creditors is confirmed only with the posted journal that clears their payable.
    SELECT sum(i.amount_cents) INTO creditor_cents FROM public.payroll_bank_file_items i
     WHERE i.file_id = NEW.id AND i.company_id = NEW.company_id AND i.garnishee_order_id IS NOT NULL;
    IF creditor_cents IS NULL THEN
      IF NEW.creditor_journal_id IS NOT NULL THEN
        RAISE EXCEPTION 'payroll_bank_files: a file without creditor lines has no creditor journal' USING ERRCODE = 'check_violation';
      END IF;
    ELSIF NEW.creditor_journal_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.gl_journal_entries je
       WHERE je.id = NEW.creditor_journal_id AND je.company_id = NEW.company_id AND je.status = 'posted'
         AND je.source_record_id = NEW.id
         AND (SELECT round(sum(jl.debit) * 100)::bigint FROM public.gl_journal_lines jl WHERE jl.journal_entry_id = je.id) = creditor_cents
    ) THEN
      RAISE EXCEPTION 'payroll_bank_files: a file that paid garnishee creditors is confirmed with its posted creditor journal'
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.confirmed_by := uid;
    NEW.confirmed_at := clock_timestamp();
  ELSE
    IF NOT NEW.void_not_sent THEN
      RAISE EXCEPTION 'payroll_bank_files: a void must attest the file was not sent to the bank' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.creditor_journal_id IS NOT NULL THEN
      RAISE EXCEPTION 'payroll_bank_files: a voided file has no creditor journal' USING ERRCODE = 'check_violation';
    END IF;
    NEW.voided_by := uid;
    NEW.voided_at := clock_timestamp();
  END IF;
  RETURN NEW;
END $$;


-- ── The order's balance counts what a confirmed file paid (breaker round 2 on #1929; coordinator ruling) ─────────
-- 999z held balance = total_debt - applied deductions, and a reopen unapplies its run's deductions: a run whose file the
-- bank had paid (confirmed) then gave its instalment back to the balance, and later months garnished (and paid) it again
-- (R40 000 on a R30 000 order). The amount counted against the debt is now, per run, the GREATER of what its approval
-- applied and what its confirmed salary bank files paid the creditor. A reopen keeps the paid part; a re-approval of the
-- same amount counts it once (GREATEST, per run and order); a different amount is refused at approval
-- (payrollBankFileReapproval) and at confirm (CREDITOR_AMOUNT_DIFFERS), so the two never disagree on a live run.
-- INVOKER, STABLE: it reads under the caller's RLS, as the guard it serves.
CREATE OR REPLACE FUNCTION public.payroll_garnishee_order_counted(p_order uuid) RETURNS numeric
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT COALESCE(sum(GREATEST(COALESCE(d.amount, 0), COALESCE(p.paid, 0))), 0)
    FROM (SELECT run_id, sum(amount) AS amount FROM public.payroll_garnishee_deductions
           WHERE order_id = p_order AND balance_applied GROUP BY run_id) d
    FULL JOIN (SELECT f.run_id, sum(i.amount_cents)::numeric / 100 AS paid
                 FROM public.payroll_bank_file_items i
                 JOIN public.payroll_bank_files f ON f.id = i.file_id AND f.company_id = i.company_id
                WHERE i.garnishee_order_id = p_order AND f.status = 'confirmed'
                GROUP BY f.run_id) p ON p.run_id = d.run_id
$$;
GRANT EXECUTE ON FUNCTION public.payroll_garnishee_order_counted(uuid) TO app_user;

-- 999z's order guard, unchanged but for the balance line (the counted amount above).
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
    -- The company's payroll approval lock (payrollRunLock.payrollApprovalLockScope), which calculate, approve and
    -- reopen hold for their whole transaction: an order is never committed in the middle of a calculation, whoever
    -- writes it, and created_at below is stamped after any calculation in flight (review #1574 round 2).
    PERFORM pg_advisory_xact_lock(hashtextextended('payroll_approval:' || NEW.company_id::text, 0));
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
    -- 1057 (GC2): per run, the larger of what its approval applied and what a confirmed salary bank file paid the
    -- creditor (payroll_garnishee_order_counted): a reopen does not give back what the bank already paid.
    applied := public.payroll_garnishee_order_counted(NEW.id);
    IF NEW.balance IS DISTINCT FROM NEW.total_debt - applied THEN
      RAISE EXCEPTION 'payroll_garnishee_orders: the balance is the total debt less the deductions applied or paid (%)', NEW.total_debt - applied
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.status = 'ended' AND OLD.status <> 'ended' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('payroll_approval:' || NEW.company_id::text, 0)); -- as INSERT
    IF uid IS NULL THEN
      RAISE EXCEPTION 'payroll_garnishee_orders: ending an order needs a session user' USING ERRCODE = '42501';
    END IF;
    NEW.ended_by := uid;
    NEW.ended_at := clock_timestamp();
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;

GRANT INSERT (garnishee_order_id, creditor_account_holder, creditor_bank_name, creditor_branch_code, creditor_account_number,
  creditor_account_type, creditor_bank_set_at) ON public.payroll_bank_file_items TO app_user;
GRANT UPDATE (creditor_journal_id) ON public.payroll_bank_files TO app_user;

SELECT public.app_service_sync_policies();
