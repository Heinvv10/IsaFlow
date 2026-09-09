-- Payroll population serialization complements current-row locks; it is not an authorization substitute.
CREATE OR REPLACE FUNCTION public.control_payroll_mutation_fence()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
DECLARE tenant uuid := app.current_company_id();
BEGIN
  IF tenant IS NULL THEN
    IF current_user='app_user' THEN
      RAISE EXCEPTION 'Authenticated payroll tenant required' USING ERRCODE='42501';
    END IF;
    -- Explicit migration/DB administrative sessions can seed schemas and synthetic fixtures.
    RETURN NULL;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('control-payroll:' || tenant::text,0));
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.control_payroll_mutation_fence() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.control_payroll_mutation_fence() TO app_user,migration_admin;
DO $$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'payroll_run_headers','payroll_run_lines','payroll_employees','payroll_components',
    'payroll_employee_components','payroll_employee_cost_allocations','cost_centre_gl_mappings',
    'cost_centres','payroll_loans','payroll_loan_schedule','payroll_loan_payments',
    'payroll_leave_balances','payroll_leave_types','payroll_bank_details'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS control_payroll_mutation_fence ON public.%I',target);
    EXECUTE format('CREATE TRIGGER control_payroll_mutation_fence BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.control_payroll_mutation_fence()',target);
  END LOOP;
END;
$$;
CREATE UNIQUE INDEX IF NOT EXISTS payroll_run_headers_company_id_id_uq
  ON payroll_run_headers(company_id,id);
CREATE TABLE IF NOT EXISTS control_payroll_calculations (
  company_id uuid NOT NULL,
  run_id uuid NOT NULL,
  calculation_version bigint NOT NULL CHECK(calculation_version>0),
  input_hash text NOT NULL CHECK(input_hash ~ '^[0-9a-f]{64}$'),
  output_hash text NOT NULL CHECK(output_hash ~ '^[0-9a-f]{64}$'),
  created_by text NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(company_id,run_id,calculation_version),
  FOREIGN KEY(company_id,run_id) REFERENCES payroll_run_headers(company_id,id)
);
ALTER TABLE control_payroll_calculations ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_payroll_calculations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_read ON control_payroll_calculations;
CREATE POLICY tenant_read ON control_payroll_calculations FOR SELECT
  USING(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()));
DROP POLICY IF EXISTS tenant_create ON control_payroll_calculations;
CREATE POLICY tenant_create ON control_payroll_calculations FOR INSERT
  WITH CHECK(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies())
    AND created_by=auth.uid()::text);
REVOKE ALL ON control_payroll_calculations FROM PUBLIC,app_user;
GRANT SELECT,INSERT ON control_payroll_calculations TO app_user;
