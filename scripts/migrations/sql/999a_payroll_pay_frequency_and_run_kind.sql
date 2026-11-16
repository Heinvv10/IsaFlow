-- 999a: pay frequency and run kind, schema only (wave 6 FQa). No figure changes.
--
-- WHAT.
--   payroll_employees.pay_frequency  'monthly' | 'fortnightly' | 'weekly', default 'monthly'. Nothing sets it to
--     anything else in this release: a monthly run pays only monthly employees (payrollEmployeeService), and
--     payrollRunKindGuard refuses a run whose line employees differ from the run's frequency.
--   payroll_run_headers gains
--     pay_frequency     same values, default 'monthly';
--     run_kind          'regular' | 'off_cycle', default 'regular';
--     off_cycle_reason  'bonus' | 'termination', set exactly when run_kind = 'off_cycle';
--     period_start / period_end  the dates the run pays for. For a monthly regular run, the calendar month
--       (payroll_month_period_start / _end); every existing row is backfilled so, and a BEFORE trigger fills
--       them for an insert that leaves them NULL, and recomputes them when a monthly regular run's month changes.
--   payroll_run_headers_regular_period_key  one regular run per (company, frequency, period start). Deterministic
--     with the backfill: (year, month) -> the 1st of that month is one-to-one, and the existing
--     UNIQUE (company_id, period_year, period_month) already holds on every row. That old constraint STAYS
--     (it is dropped by FQx, a later contract step).
--   payroll_company_settings  per company: the pay week (ISO day numbers, 1 = Monday; default Monday-Sunday with
--     Friday pay, Hein's Q5 ruling), the fortnight anchor, and the payslip-email and employee-portal switches (both
--     off). No row means the defaults. A new small table rather than columns on companies, which would take an
--     ACCESS EXCLUSIVE lock on the busiest table (grill F27). Only the pay-week columns are writable by app_user
--     here; the PE and SS migrations grant their own switch.
--   feature_flags  the three platform kill switches of spec rule 20, created OFF (is_global = false); only a
--     platform admin enables them.
--
-- OLD COLOUR (the release before this one runs against this schema while the deploy switches colours):
--   insert  createPayrollRun writes company_id, period_month, period_year, created_by only: pay_frequency and
--           run_kind take their defaults, the trigger fills period_start / period_end from the month, the new
--           CHECKs hold, and ON CONFLICT (company_id, period_year, period_month) still names an existing unique
--           constraint. Both unique keys hold for a monthly regular row.
--   update  the old code never writes period_year / period_month after insert, so the trigger never fires on
--           its updates; status, totals and approval writes do not touch the new columns.
--   read    SELECT * returns the extra columns; mapRunRow ignores columns it does not name.
--   employees  inserts take the default 'monthly'; the old run costs every employee, all of them monthly.
--
-- LOCKS. ADD COLUMN with a constant default is catalogue-only (PG 11+), but takes ACCESS EXCLUSIVE on
-- payroll_employees and payroll_run_headers and holds it to the end of this transaction, so the backfill, the
-- VALIDATEs and the index build all run under it: both tables are small (hundreds of rows). Acquiring each lock
-- is bounded by lock_timeout, the whole by statement_timeout.
--
-- Rollback (down SQL; roll the code back first, to a release that never reads these columns):
--   DROP TRIGGER IF EXISTS payroll_run_headers_fill_period ON public.payroll_run_headers;
--   DROP FUNCTION IF EXISTS public.payroll_run_headers_fill_period();
--   DROP INDEX IF EXISTS public.payroll_run_headers_regular_period_key;
--   ALTER TABLE public.payroll_run_headers DROP COLUMN IF EXISTS period_end, DROP COLUMN IF EXISTS period_start,
--     DROP COLUMN IF EXISTS off_cycle_reason, DROP COLUMN IF EXISTS run_kind, DROP COLUMN IF EXISTS pay_frequency;
--   ALTER TABLE public.payroll_employees DROP COLUMN IF EXISTS pay_frequency;
--   DROP FUNCTION IF EXISTS public.payroll_month_period_start(integer, integer);
--   DROP FUNCTION IF EXISTS public.payroll_month_period_end(integer, integer);
--   DROP TABLE IF EXISTS public.payroll_company_settings;
--   DELETE FROM public.feature_flags WHERE code IN ('payroll_payslip_email', 'payroll_employee_portal', 'payroll_salary_bank_file');
--   SELECT public.app_service_sync_policies();

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- ── 1. The calendar month a monthly run pays for ───────────────────────────
CREATE OR REPLACE FUNCTION public.payroll_month_period_start(p_year integer, p_month integer)
RETURNS date LANGUAGE sql IMMUTABLE STRICT
SET search_path = pg_catalog, pg_temp
AS $$ SELECT pg_catalog.make_date(p_year, p_month, 1) $$;

CREATE OR REPLACE FUNCTION public.payroll_month_period_end(p_year integer, p_month integer)
RETURNS date LANGUAGE sql IMMUTABLE STRICT
SET search_path = pg_catalog, pg_temp
AS $$ SELECT (pg_catalog.make_date(p_year, p_month, 1) + interval '1 month' - interval '1 day')::date $$;

-- ── 2. Employees ───────────────────────────────────────────────────────────
ALTER TABLE public.payroll_employees ADD COLUMN IF NOT EXISTS pay_frequency text NOT NULL DEFAULT 'monthly';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'payroll_employees_pay_frequency_check' AND conrelid = 'public.payroll_employees'::regclass) THEN
    ALTER TABLE public.payroll_employees ADD CONSTRAINT payroll_employees_pay_frequency_check
      CHECK (pay_frequency IN ('monthly', 'fortnightly', 'weekly')) NOT VALID;
  END IF;
END $$;
ALTER TABLE public.payroll_employees VALIDATE CONSTRAINT payroll_employees_pay_frequency_check;

-- ── 3. Run headers ─────────────────────────────────────────────────────────
ALTER TABLE public.payroll_run_headers ADD COLUMN IF NOT EXISTS pay_frequency text NOT NULL DEFAULT 'monthly';
ALTER TABLE public.payroll_run_headers ADD COLUMN IF NOT EXISTS run_kind text NOT NULL DEFAULT 'regular';
ALTER TABLE public.payroll_run_headers ADD COLUMN IF NOT EXISTS off_cycle_reason text;
ALTER TABLE public.payroll_run_headers ADD COLUMN IF NOT EXISTS period_start date;
ALTER TABLE public.payroll_run_headers ADD COLUMN IF NOT EXISTS period_end date;

-- Every existing row is monthly regular (the defaults just applied): its calendar month.
UPDATE public.payroll_run_headers
   SET period_start = public.payroll_month_period_start(period_year, period_month),
       period_end   = public.payroll_month_period_end(period_year, period_month)
 WHERE period_start IS NULL OR period_end IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'payroll_run_headers_pay_frequency_check' AND conrelid = 'public.payroll_run_headers'::regclass) THEN
    ALTER TABLE public.payroll_run_headers ADD CONSTRAINT payroll_run_headers_pay_frequency_check
      CHECK (pay_frequency IN ('monthly', 'fortnightly', 'weekly')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'payroll_run_headers_run_kind_check' AND conrelid = 'public.payroll_run_headers'::regclass) THEN
    ALTER TABLE public.payroll_run_headers ADD CONSTRAINT payroll_run_headers_run_kind_check
      CHECK (run_kind IN ('regular', 'off_cycle')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'payroll_run_headers_off_cycle_reason_check' AND conrelid = 'public.payroll_run_headers'::regclass) THEN
    ALTER TABLE public.payroll_run_headers ADD CONSTRAINT payroll_run_headers_off_cycle_reason_check
      CHECK (off_cycle_reason IN ('bonus', 'termination')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'payroll_run_headers_off_cycle_reason_set' AND conrelid = 'public.payroll_run_headers'::regclass) THEN
    ALTER TABLE public.payroll_run_headers ADD CONSTRAINT payroll_run_headers_off_cycle_reason_set
      CHECK ((run_kind = 'off_cycle') = (off_cycle_reason IS NOT NULL)) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'payroll_run_headers_period_dates_check' AND conrelid = 'public.payroll_run_headers'::regclass) THEN
    ALTER TABLE public.payroll_run_headers ADD CONSTRAINT payroll_run_headers_period_dates_check
      CHECK (period_start IS NOT NULL AND period_end IS NOT NULL AND period_end >= period_start) NOT VALID;
  END IF;
END $$;
ALTER TABLE public.payroll_run_headers VALIDATE CONSTRAINT payroll_run_headers_pay_frequency_check;
ALTER TABLE public.payroll_run_headers VALIDATE CONSTRAINT payroll_run_headers_run_kind_check;
ALTER TABLE public.payroll_run_headers VALIDATE CONSTRAINT payroll_run_headers_off_cycle_reason_check;
ALTER TABLE public.payroll_run_headers VALIDATE CONSTRAINT payroll_run_headers_off_cycle_reason_set;
ALTER TABLE public.payroll_run_headers VALIDATE CONSTRAINT payroll_run_headers_period_dates_check;

-- A plain INVOKER trigger: it reads nothing but the row itself.
CREATE OR REPLACE FUNCTION public.payroll_run_headers_fill_period()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.pay_frequency = 'monthly' AND NEW.run_kind = 'regular' THEN
    IF TG_OP = 'INSERT' THEN
      NEW.period_start := COALESCE(NEW.period_start, public.payroll_month_period_start(NEW.period_year, NEW.period_month));
      NEW.period_end   := COALESCE(NEW.period_end, public.payroll_month_period_end(NEW.period_year, NEW.period_month));
    ELSIF NEW.period_year IS DISTINCT FROM OLD.period_year OR NEW.period_month IS DISTINCT FROM OLD.period_month THEN
      NEW.period_start := public.payroll_month_period_start(NEW.period_year, NEW.period_month);
      NEW.period_end   := public.payroll_month_period_end(NEW.period_year, NEW.period_month);
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS payroll_run_headers_fill_period ON public.payroll_run_headers;
CREATE TRIGGER payroll_run_headers_fill_period
  BEFORE INSERT OR UPDATE OF period_year, period_month ON public.payroll_run_headers
  FOR EACH ROW EXECUTE FUNCTION public.payroll_run_headers_fill_period();

-- No status filter, as the old (company_id, period_year, period_month) constraint has none.
CREATE UNIQUE INDEX IF NOT EXISTS payroll_run_headers_regular_period_key
  ON public.payroll_run_headers (company_id, pay_frequency, period_start) WHERE run_kind = 'regular';

COMMENT ON COLUMN public.payroll_run_headers.period_start IS
  'First day the run pays for (999a). Monthly regular: the 1st of period_month, filled by payroll_run_headers_fill_period when NULL.';
COMMENT ON COLUMN public.payroll_run_headers.run_kind IS
  'regular | off_cycle (999a). A release that predates off-cycle runs refuses them (payrollRunKindGuard, RUN_KIND_UNSUPPORTED).';

-- ── 4. Company payroll settings ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.payroll_company_settings (
  company_id UUID PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  pay_week_start_dow SMALLINT NOT NULL DEFAULT 1 CHECK (pay_week_start_dow BETWEEN 1 AND 7),
  pay_weekday SMALLINT NOT NULL DEFAULT 5 CHECK (pay_weekday BETWEEN 1 AND 7),
  fortnight_anchor DATE,
  payslip_email_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  employee_portal_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.payroll_company_settings IS
  'Per-company payroll settings (999a). No row = the defaults: pay week Monday (1) to Sunday, paid Friday (5), ISO day numbers; payslip email and employee portal off.';

ALTER TABLE public.payroll_company_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_company_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.payroll_company_settings;
CREATE POLICY tenant_isolation ON public.payroll_company_settings FOR ALL TO app_user
  USING (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()));
REVOKE INSERT, UPDATE, DELETE ON public.payroll_company_settings FROM app_user;
GRANT SELECT ON public.payroll_company_settings TO app_user;
GRANT INSERT (company_id, pay_week_start_dow, pay_weekday, fortnight_anchor, updated_by) ON public.payroll_company_settings TO app_user;
GRANT UPDATE (pay_week_start_dow, pay_weekday, fortnight_anchor, updated_by, updated_at) ON public.payroll_company_settings TO app_user;

-- ── 5. Platform kill switches (spec rule 20): off until a platform admin enables them ──
INSERT INTO public.feature_flags (code, name, description, is_global) VALUES
  ('payroll_payslip_email', 'Payroll: payslip email',
   'Sending payslips by email. Platform switch, checked before the company setting; off until the first live send is approved.', false),
  ('payroll_employee_portal', 'Payroll: employee self-service',
   'Employee portal invites and login. Platform switch, checked before the company setting; off until approved.', false),
  ('payroll_salary_bank_file', 'Payroll: salary bank file',
   'Generating the salary bank (ACB) file. Platform switch; off until a bank has accepted a test import.', false)
ON CONFLICT (code) DO NOTHING;

SELECT public.app_service_sync_policies();
