-- 999i: the 13-week cash forecast's stored inputs (data layer only; the engine is pure TypeScript).
--
-- WHAT.
--   payroll_company_settings (999a) gains the salary pay day (Hein, 2026-11-16):
--     salary_pay_rule  'day_of_month' | 'last_working_day', or NULL = not chosen;
--     salary_pay_day   1-31, or NULL. A day beyond the month's length means the month's last day
--                      (the engine's rule; the column only bounds it). Kept when the rule is
--                      last_working_day, so switching back restores the day.
--     Both NULL (or no row) = not chosen: the app reads day 25 and says it is the default. NO column
--     default: a NOT NULL DEFAULT 25 would backfill every existing row with a day nobody chose.
--     And a stamp trigger: updated_by / updated_at come from auth.uid() and the clock, no longer from
--     the app (app_user loses its INSERT/UPDATE grants on them). The only writer is this release's
--     payDaySetting (census 2026-11-16: src, pages, scripts, every worktree and remote branch).
--   cash_forecast_items  expected receipts and payments a user types: direction, amount (> 0, rand), a category
--     (the engine's CashCategory list, default 'other', for grouping),
--     expected_date, repeat none | weekly | monthly with an optional repeat_until, a description and an
--     optional GL account of the company. Dates lie in 2000-01-01..2100-12-31. Forecasts, so edits and deletes are allowed (each audited by
--     the service in the request transaction).
--   cash_forecast_overrides  a user's change to one forecast line in one week:
--     line_key           the engine's stable key ('ap:<supplierId>', 'payroll:net', 'manual:<itemId>', ...);
--     week_start         a Monday (2000-01-01..2100-12-31, as target_week_start);
--     mode / amount      amounts of set/add are SIGNED in the line's own sign (a payment cell is negative;
--                        the UI sends the sign from the line, the override does not know it):
--                        set: the week's figure becomes amount (required, any sign);
--                        add: amount (required, never 0) is added to the week's figure;
--                        move_to: amount (a magnitude, > 0) of the week's figure moves to target_week_start,
--                        or NULL = the whole cell moves;
--     target_week_start  move_to only (required there, NULL otherwise), a Monday, not week_start.
--     applied_at         the order the engine applies overrides in (ORDER BY applied_at, id): set on insert,
--                        restamped by the trigger ONLY when mode, amount or target_week_start change, so a
--                        note-only edit keeps a cell's place. Never granted, never forgeable.
--     One override per (company, line, week): the service upserts on that key.
--
-- RULES IN THE DATABASE.
--   - Tenancy: 944's forced-RLS policy, verbatim, on both new tables.
--   - A forecast item's GL account belongs to the item's company (trigger: gl_accounts has no
--     (company_id, id) key for a composite FK). The FK is NO ACTION: an account a forecast names is
--     not deleted (migrationRollbackService retains on 23503).
--   - Stamps: created_by/created_at on INSERT, updated_by/updated_at on every write, from auth.uid()
--     and the clock; a forged value is overwritten, a write with no session user is refused (42501),
--     and an UPDATE keeps the creation stamps and the company. ENABLE ALWAYS.
--   - Column privileges: app_user never writes id or a stamp, and never UPDATEs company_id.
--   - The service pool reaches the tables through 915's mirrors (app_service_sync_policies).
--   - payroll_company_settings' stamp trigger refuses a NULL auth.uid() for EVERY role (ENABLE ALWAYS): a
--     backfill must set request.jwt.claims, or disable trg_payroll_company_settings_stamp inside its own migration.
--
-- Every function here is SECURITY INVOKER: no app_definer_reviews row (930). Safe to re-run.
--
-- Rollback (down SQL; roll the code back first):
--   DROP TABLE IF EXISTS public.cash_forecast_overrides;
--   DROP TABLE IF EXISTS public.cash_forecast_items;
--   DROP FUNCTION IF EXISTS public.cash_forecast_stamp();
--   DROP FUNCTION IF EXISTS public.cash_forecast_items_check_account();
--   DROP FUNCTION IF EXISTS public.cash_forecast_overrides_applied_at();
--   DROP TRIGGER IF EXISTS trg_payroll_company_settings_stamp ON public.payroll_company_settings;
--   DROP FUNCTION IF EXISTS public.payroll_company_settings_stamp();
--   GRANT INSERT (updated_by) ON public.payroll_company_settings TO app_user;
--   GRANT UPDATE (updated_by, updated_at) ON public.payroll_company_settings TO app_user;
--   ALTER TABLE public.payroll_company_settings DROP COLUMN IF EXISTS salary_pay_day, DROP COLUMN IF EXISTS salary_pay_rule;
--   SELECT public.app_service_sync_policies();

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- ── 1. Salary pay day on payroll_company_settings ──────────────────────────
ALTER TABLE public.payroll_company_settings ADD COLUMN IF NOT EXISTS salary_pay_rule TEXT;
ALTER TABLE public.payroll_company_settings ADD COLUMN IF NOT EXISTS salary_pay_day SMALLINT;
-- An earlier draft had them NOT NULL DEFAULT 'day_of_month' / 25: never again a backfilled choice.
ALTER TABLE public.payroll_company_settings
  ALTER COLUMN salary_pay_rule DROP DEFAULT, ALTER COLUMN salary_pay_rule DROP NOT NULL,
  ALTER COLUMN salary_pay_day DROP DEFAULT, ALTER COLUMN salary_pay_day DROP NOT NULL;
ALTER TABLE public.payroll_company_settings DROP CONSTRAINT IF EXISTS payroll_company_settings_salary_pay_rule_check;
ALTER TABLE public.payroll_company_settings ADD CONSTRAINT payroll_company_settings_salary_pay_rule_check
  CHECK (salary_pay_rule IS NULL OR salary_pay_rule IN ('day_of_month', 'last_working_day'));
ALTER TABLE public.payroll_company_settings DROP CONSTRAINT IF EXISTS payroll_company_settings_salary_pay_day_check;
ALTER TABLE public.payroll_company_settings ADD CONSTRAINT payroll_company_settings_salary_pay_day_check
  CHECK (salary_pay_day IS NULL OR salary_pay_day BETWEEN 1 AND 31);
-- Not chosen = both NULL; day_of_month needs its day; last_working_day may keep one (or none ever chosen).
ALTER TABLE public.payroll_company_settings DROP CONSTRAINT IF EXISTS payroll_company_settings_salary_pay_shape;
ALTER TABLE public.payroll_company_settings ADD CONSTRAINT payroll_company_settings_salary_pay_shape
  -- Written so no branch is NULL (a NULL CHECK passes): a day with no rule must come out false.
  CHECK ((salary_pay_rule IS NULL AND salary_pay_day IS NULL)
      OR (salary_pay_rule IS NOT NULL AND (salary_pay_rule <> 'day_of_month' OR salary_pay_day IS NOT NULL)));
GRANT INSERT (salary_pay_rule, salary_pay_day) ON public.payroll_company_settings TO app_user;
GRANT UPDATE (salary_pay_rule, salary_pay_day) ON public.payroll_company_settings TO app_user;
COMMENT ON COLUMN public.payroll_company_settings.salary_pay_day IS
  'Salaries paid on this day of the month (999i); beyond the month''s length = its last day. NULL with salary_pay_rule NULL = not chosen (the app reads 25).';

-- updated_by / updated_at: the trigger's, never the app's.
CREATE OR REPLACE FUNCTION public.payroll_company_settings_stamp()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  uid text := auth.uid();
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'payroll_company_settings: a write needs a session user' USING ERRCODE = '42501';
  END IF;
  NEW.updated_by := uid;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.payroll_company_settings_stamp() FROM PUBLIC;
DROP TRIGGER IF EXISTS trg_payroll_company_settings_stamp ON public.payroll_company_settings;
CREATE TRIGGER trg_payroll_company_settings_stamp BEFORE INSERT OR UPDATE ON public.payroll_company_settings
  FOR EACH ROW EXECUTE FUNCTION public.payroll_company_settings_stamp();
ALTER TABLE public.payroll_company_settings ENABLE ALWAYS TRIGGER trg_payroll_company_settings_stamp;
REVOKE INSERT (updated_by) ON public.payroll_company_settings FROM app_user;
REVOKE UPDATE (updated_by, updated_at) ON public.payroll_company_settings FROM app_user;

-- ── 2. Shared stamp trigger ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cash_forecast_stamp()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  uid text := auth.uid();
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION '%: a write needs a session user', TG_TABLE_NAME USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.created_by := uid;
    NEW.created_at := clock_timestamp();
  ELSE
    IF NEW.company_id IS DISTINCT FROM OLD.company_id THEN
      RAISE EXCEPTION '%: a row''s company never changes', TG_TABLE_NAME USING ERRCODE = '42501';
    END IF;
    NEW.id := OLD.id;
    NEW.created_by := OLD.created_by;
    NEW.created_at := OLD.created_at;
  END IF;
  NEW.updated_by := uid;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.cash_forecast_stamp() FROM PUBLIC;

-- ── 3. cash_forecast_items ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.cash_forecast_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  direction TEXT NOT NULL,
  amount NUMERIC(15, 2) NOT NULL,
  expected_date DATE NOT NULL,
  repeat TEXT NOT NULL DEFAULT 'none',
  category TEXT NOT NULL DEFAULT 'other',
  repeat_until DATE,
  description TEXT NOT NULL,
  gl_account_id UUID REFERENCES public.gl_accounts(id),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- An earlier draft of this file created the table without category: bring it to this shape.
ALTER TABLE public.cash_forecast_items ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'other';
ALTER TABLE public.cash_forecast_items DROP CONSTRAINT IF EXISTS cash_forecast_items_direction_check;
ALTER TABLE public.cash_forecast_items ADD CONSTRAINT cash_forecast_items_direction_check
  CHECK (direction IN ('receipt', 'payment'));
ALTER TABLE public.cash_forecast_items DROP CONSTRAINT IF EXISTS cash_forecast_items_amount_check;
ALTER TABLE public.cash_forecast_items ADD CONSTRAINT cash_forecast_items_amount_check CHECK (amount > 0);
ALTER TABLE public.cash_forecast_items DROP CONSTRAINT IF EXISTS cash_forecast_items_category_check;
ALTER TABLE public.cash_forecast_items ADD CONSTRAINT cash_forecast_items_category_check
  CHECK (category IN ('customer_receipts', 'supplier_payments', 'payroll', 'sars', 'loans', 'other'));
ALTER TABLE public.cash_forecast_items DROP CONSTRAINT IF EXISTS cash_forecast_items_repeat_check;
ALTER TABLE public.cash_forecast_items ADD CONSTRAINT cash_forecast_items_repeat_check
  CHECK (repeat IN ('none', 'weekly', 'monthly'));
-- A one-off item has no end; a repeating item's end is on or after its first date.
ALTER TABLE public.cash_forecast_items DROP CONSTRAINT IF EXISTS cash_forecast_items_repeat_until_check;
ALTER TABLE public.cash_forecast_items ADD CONSTRAINT cash_forecast_items_repeat_until_check
  CHECK (repeat_until IS NULL OR (repeat <> 'none' AND repeat_until >= expected_date));
ALTER TABLE public.cash_forecast_items DROP CONSTRAINT IF EXISTS cash_forecast_items_dates_in_range;
ALTER TABLE public.cash_forecast_items ADD CONSTRAINT cash_forecast_items_dates_in_range
  CHECK (expected_date BETWEEN DATE '2000-01-01' AND DATE '2100-12-31'
     AND (repeat_until IS NULL OR repeat_until BETWEEN DATE '2000-01-01' AND DATE '2100-12-31'));
ALTER TABLE public.cash_forecast_items DROP CONSTRAINT IF EXISTS cash_forecast_items_description_check;
ALTER TABLE public.cash_forecast_items ADD CONSTRAINT cash_forecast_items_description_check
  CHECK (btrim(description) <> '' AND length(description) <= 200);
CREATE INDEX IF NOT EXISTS idx_cash_forecast_items_company_date ON public.cash_forecast_items (company_id, expected_date);
CREATE INDEX IF NOT EXISTS idx_cash_forecast_items_gl_account ON public.cash_forecast_items (gl_account_id)
  WHERE gl_account_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.cash_forecast_items_check_account()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.gl_account_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM gl_accounts ga WHERE ga.id = NEW.gl_account_id AND ga.company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'cash forecast item account % does not belong to company %', NEW.gl_account_id, NEW.company_id
      USING ERRCODE = '23514', CONSTRAINT = 'cash_forecast_items_account_company';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.cash_forecast_items_check_account() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_cash_forecast_items_stamp ON public.cash_forecast_items;
CREATE TRIGGER trg_cash_forecast_items_stamp BEFORE INSERT OR UPDATE ON public.cash_forecast_items
  FOR EACH ROW EXECUTE FUNCTION public.cash_forecast_stamp();
ALTER TABLE public.cash_forecast_items ENABLE ALWAYS TRIGGER trg_cash_forecast_items_stamp;
DROP TRIGGER IF EXISTS trg_cash_forecast_items_account ON public.cash_forecast_items;
CREATE TRIGGER trg_cash_forecast_items_account BEFORE INSERT OR UPDATE OF company_id, gl_account_id ON public.cash_forecast_items
  FOR EACH ROW EXECUTE FUNCTION public.cash_forecast_items_check_account();
ALTER TABLE public.cash_forecast_items ENABLE ALWAYS TRIGGER trg_cash_forecast_items_account;

ALTER TABLE public.cash_forecast_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cash_forecast_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.cash_forecast_items;
CREATE POLICY tenant_isolation ON public.cash_forecast_items FOR ALL TO app_user
  USING (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()));
REVOKE INSERT, UPDATE, DELETE ON public.cash_forecast_items FROM app_user;
GRANT SELECT, DELETE ON public.cash_forecast_items TO app_user;
GRANT INSERT (company_id, direction, amount, expected_date, repeat, repeat_until, description, gl_account_id, category)
  ON public.cash_forecast_items TO app_user;
GRANT UPDATE (direction, amount, expected_date, repeat, repeat_until, description, gl_account_id, category)
  ON public.cash_forecast_items TO app_user;

-- ── 4. cash_forecast_overrides ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.cash_forecast_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  line_key TEXT NOT NULL,
  week_start DATE NOT NULL,
  mode TEXT NOT NULL,
  amount NUMERIC(15, 2),
  target_week_start DATE,
  note TEXT,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Earlier drafts: no applied_at (the order trigger reads it), amount NOT NULL (move_to may be NULL now).
ALTER TABLE public.cash_forecast_overrides ADD COLUMN IF NOT EXISTS applied_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE public.cash_forecast_overrides ALTER COLUMN amount DROP NOT NULL;
ALTER TABLE public.cash_forecast_overrides DROP CONSTRAINT IF EXISTS cash_forecast_overrides_line_key_check;
ALTER TABLE public.cash_forecast_overrides ADD CONSTRAINT cash_forecast_overrides_line_key_check
  CHECK (btrim(line_key) <> '' AND length(line_key) <= 200);
ALTER TABLE public.cash_forecast_overrides DROP CONSTRAINT IF EXISTS cash_forecast_overrides_week_monday;
ALTER TABLE public.cash_forecast_overrides ADD CONSTRAINT cash_forecast_overrides_week_monday
  CHECK (EXTRACT(ISODOW FROM week_start) = 1);
ALTER TABLE public.cash_forecast_overrides DROP CONSTRAINT IF EXISTS cash_forecast_overrides_dates_in_range;
ALTER TABLE public.cash_forecast_overrides ADD CONSTRAINT cash_forecast_overrides_dates_in_range
  CHECK (week_start BETWEEN DATE '2000-01-01' AND DATE '2100-12-31'
     AND (target_week_start IS NULL OR target_week_start BETWEEN DATE '2000-01-01' AND DATE '2100-12-31'));
ALTER TABLE public.cash_forecast_overrides DROP CONSTRAINT IF EXISTS cash_forecast_overrides_mode_amount;
ALTER TABLE public.cash_forecast_overrides ADD CONSTRAINT cash_forecast_overrides_mode_amount
  CHECK (CASE mode
    WHEN 'set' THEN amount IS NOT NULL
    WHEN 'add' THEN amount IS NOT NULL AND amount <> 0
    WHEN 'move_to' THEN amount IS NULL OR amount > 0
    ELSE false END);
ALTER TABLE public.cash_forecast_overrides DROP CONSTRAINT IF EXISTS cash_forecast_overrides_target;
ALTER TABLE public.cash_forecast_overrides ADD CONSTRAINT cash_forecast_overrides_target
  CHECK (CASE WHEN mode = 'move_to'
    THEN target_week_start IS NOT NULL AND EXTRACT(ISODOW FROM target_week_start) = 1 AND target_week_start <> week_start
    ELSE target_week_start IS NULL END);
ALTER TABLE public.cash_forecast_overrides DROP CONSTRAINT IF EXISTS cash_forecast_overrides_note_check;
ALTER TABLE public.cash_forecast_overrides ADD CONSTRAINT cash_forecast_overrides_note_check
  CHECK (note IS NULL OR length(note) <= 500);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cash_forecast_overrides_line_week
  ON public.cash_forecast_overrides (company_id, line_key, week_start);

DROP TRIGGER IF EXISTS trg_cash_forecast_overrides_stamp ON public.cash_forecast_overrides;
CREATE TRIGGER trg_cash_forecast_overrides_stamp BEFORE INSERT OR UPDATE ON public.cash_forecast_overrides
  FOR EACH ROW EXECUTE FUNCTION public.cash_forecast_stamp();
ALTER TABLE public.cash_forecast_overrides ENABLE ALWAYS TRIGGER trg_cash_forecast_overrides_stamp;

-- The application order: a new figure (mode, amount or target) moves the override to the end; anything else
-- (a note, a no-op) keeps OLD.applied_at, whatever the writer sent.
CREATE OR REPLACE FUNCTION public.cash_forecast_overrides_applied_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT'
     OR (NEW.mode, NEW.amount, NEW.target_week_start) IS DISTINCT FROM (OLD.mode, OLD.amount, OLD.target_week_start) THEN
    NEW.applied_at := clock_timestamp();
  ELSE
    NEW.applied_at := OLD.applied_at;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.cash_forecast_overrides_applied_at() FROM PUBLIC;
DROP TRIGGER IF EXISTS trg_cash_forecast_overrides_applied_at ON public.cash_forecast_overrides;
CREATE TRIGGER trg_cash_forecast_overrides_applied_at BEFORE INSERT OR UPDATE ON public.cash_forecast_overrides
  FOR EACH ROW EXECUTE FUNCTION public.cash_forecast_overrides_applied_at();
ALTER TABLE public.cash_forecast_overrides ENABLE ALWAYS TRIGGER trg_cash_forecast_overrides_applied_at;

ALTER TABLE public.cash_forecast_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cash_forecast_overrides FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.cash_forecast_overrides;
CREATE POLICY tenant_isolation ON public.cash_forecast_overrides FOR ALL TO app_user
  USING (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()));
REVOKE INSERT, UPDATE, DELETE ON public.cash_forecast_overrides FROM app_user;
GRANT SELECT, DELETE ON public.cash_forecast_overrides TO app_user;
GRANT INSERT (company_id, line_key, week_start, mode, amount, target_week_start, note)
  ON public.cash_forecast_overrides TO app_user;
GRANT UPDATE (mode, amount, target_week_start, note) ON public.cash_forecast_overrides TO app_user;

COMMENT ON TABLE public.cash_forecast_items IS
  'Expected cash receipts/payments typed by users for the 13-week cash forecast (999i). Editable; audited by the service.';
COMMENT ON TABLE public.cash_forecast_overrides IS
  'Per-line, per-week overrides of the 13-week cash forecast (999i): set | add | move_to. One per (company, line_key, week_start).';

SELECT public.app_service_sync_policies();
