-- 944: Budgets keyed by calendar month (change-of-year-end programme,
-- Feature E; Hein's decision 2026-10-22).
--
-- WHY. accounting_budgets stored twelve amounts per account per fiscal-year
-- LABEL, keyed 'jan'..'dec', and every reader capped a year at twelve months.
-- A 14-month transition year cannot be budgeted that way, and after a change of
-- year end the months of a label are not the same months any more. An amount
-- now belongs to a calendar month ('YYYY-MM-01'); the year it counts in is
-- whichever financial year holds that month (gl/fiscalYearRegistry).
--
-- accounting_budgets stays, as the per-account, per-year header that holds the
-- user's notes; its period_amounts / annual_amount / total_amount are no
-- longer read or written by the app (left in place, not dropped: the
-- conversion below is verified, and dropping is irreversible).
--
-- CONVERSION. Each stored month key of a budget row is read as the readers
-- read it: the month of that name inside the row's fiscal year, which is the
-- company's fiscal_periods row with that label and that calendar month (every
-- company today labels January-December, so FY2026 'mar' is March 2026); with
-- no such period, the month of that name inside the registry year carrying the
-- label. A row with no monthly split spreads annual_amount over the twelve
-- months, cents on the last, as the reader pro-rated it. Totals are verified
-- per company and account; a collision (two rows claiming one month) fails
-- the migration rather than merging silently.

CREATE TABLE IF NOT EXISTS budget_month_amounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  gl_account_id UUID NOT NULL REFERENCES gl_accounts(id) ON DELETE CASCADE,
  month DATE NOT NULL CHECK (EXTRACT(DAY FROM month) = 1),
  amount NUMERIC(15, 2) NOT NULL,
  created_by VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT budget_month_amounts_one_per_month UNIQUE (company_id, gl_account_id, month)
);

ALTER TABLE budget_month_amounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_month_amounts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON budget_month_amounts;
CREATE POLICY tenant_isolation ON budget_month_amounts TO app_user
  USING (company_id IN (SELECT cu.company_id FROM company_users cu WHERE cu.user_id = auth.uid()))
  WITH CHECK (company_id = app.current_company_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON budget_month_amounts TO app_user;

DROP TRIGGER IF EXISTS trg_budget_month_amounts_updated_at ON budget_month_amounts;
CREATE TRIGGER trg_budget_month_amounts_updated_at BEFORE UPDATE ON budget_month_amounts
  FOR EACH ROW EXECUTE FUNCTION accounting_updated_at();

-- An account of another company cannot carry this company's budget.
CREATE OR REPLACE FUNCTION public.budget_month_amounts_same_company()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM gl_accounts ga WHERE ga.id = NEW.gl_account_id AND ga.company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'budget account % does not belong to company %', NEW.gl_account_id, NEW.company_id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_budget_month_amounts_same_company ON budget_month_amounts;
CREATE TRIGGER trg_budget_month_amounts_same_company BEFORE INSERT OR UPDATE OF company_id, gl_account_id ON budget_month_amounts
  FOR EACH ROW EXECUTE FUNCTION public.budget_month_amounts_same_company();

-- ── Conversion ───────────────────────────────────────────────────────────────

DO $$
DECLARE
  b record; k text; idx int; mon int; val numeric; month_date date; yr record;
  keys text[] := ARRAY['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  monthly numeric; inserted int; converted int := 0;
BEGIN
  FOR b IN
    SELECT id, company_id, gl_account_id, fiscal_year, COALESCE(period_amounts, '{}'::jsonb) AS pa,
           COALESCE(annual_amount, 0) AS annual, created_by
      FROM accounting_budgets WHERE gl_account_id IS NOT NULL AND company_id IS NOT NULL
  LOOP
    SELECT * INTO yr FROM public.fiscal_year_for_label(b.company_id, b.fiscal_year);
    FOR idx IN 1..12 LOOP
      k := keys[idx];
      IF jsonb_typeof(b.pa) = 'object' AND (SELECT COUNT(*) FROM jsonb_object_keys(b.pa)) > 0 THEN
        val := COALESCE((b.pa ->> k)::numeric, (b.pa ->> (idx - 1)::text)::numeric);
        CONTINUE WHEN val IS NULL;
      ELSE
        CONTINUE WHEN b.annual = 0;
        monthly := round(b.annual / 12, 2);
        val := CASE WHEN idx = 12 THEN b.annual - monthly * 11 ELSE monthly END;
      END IF;
      mon := idx;
      SELECT fp.start_date INTO month_date FROM fiscal_periods fp
       WHERE fp.company_id = b.company_id AND fp.fiscal_year = b.fiscal_year
         AND EXTRACT(MONTH FROM fp.start_date)::int = mon AND EXTRACT(DAY FROM fp.start_date) = 1
       ORDER BY fp.start_date LIMIT 1;
      IF month_date IS NULL AND yr.start_date IS NOT NULL THEN
        SELECT d::date INTO month_date
          FROM generate_series(date_trunc('month', yr.start_date), yr.end_date, INTERVAL '1 month') d
         WHERE EXTRACT(MONTH FROM d)::int = mon ORDER BY d LIMIT 1;
      END IF;
      IF month_date IS NULL THEN month_date := make_date(b.fiscal_year, mon, 1); END IF;
      INSERT INTO budget_month_amounts (company_id, gl_account_id, month, amount, created_by)
      VALUES (b.company_id, b.gl_account_id, month_date, val, b.created_by)
      ON CONFLICT (company_id, gl_account_id, month) DO NOTHING;
      GET DIAGNOSTICS inserted = ROW_COUNT;
      IF inserted = 0 THEN
        RAISE EXCEPTION '944: budget % (FY%) and another budget both claim % for account %', b.id, b.fiscal_year, month_date, b.gl_account_id;
      END IF;
      converted := converted + 1;
      month_date := NULL;
    END LOOP;
  END LOOP;
  RAISE NOTICE '944: converted % budget months', converted;
END;
$$;

-- Verification: every account's total is unchanged.
DO $$
DECLARE
  bad int;
BEGIN
  WITH src AS (
    SELECT b.company_id, b.gl_account_id,
           SUM(CASE WHEN (SELECT COUNT(*) FROM jsonb_object_keys(COALESCE(b.period_amounts, '{}'::jsonb))) > 0
                    THEN (SELECT COALESCE(SUM(v::numeric), 0) FROM jsonb_each_text(b.period_amounts) e(k, v)
                           WHERE e.k IN ('jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec',
                                         '0','1','2','3','4','5','6','7','8','9','10','11'))
                    ELSE COALESCE(b.annual_amount, 0) END) AS total
      FROM accounting_budgets b WHERE b.gl_account_id IS NOT NULL AND b.company_id IS NOT NULL
     GROUP BY 1, 2
  ), dst AS (
    SELECT company_id, gl_account_id, SUM(amount) AS total FROM budget_month_amounts GROUP BY 1, 2
  )
  SELECT COUNT(*) INTO bad FROM src FULL JOIN dst USING (company_id, gl_account_id)
   WHERE COALESCE(src.total, 0) <> COALESCE(dst.total, 0);
  IF bad > 0 THEN
    RAISE EXCEPTION '944 verification failed: % company/account budget totals differ after conversion', bad;
  END IF;
END;
$$;

COMMENT ON COLUMN accounting_budgets.period_amounts IS
  'Superseded by budget_month_amounts (migration 944); no longer read or written by the app.';
