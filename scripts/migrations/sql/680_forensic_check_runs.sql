-- Complete-population check runs extend the authenticated job queue; results are generation-bound and sealed.
-- Shared objects (root-coordinated): control_audit_job_intents_kind_check and control_audit_jobs_result_check.
-- The constraint swaps take ACCESS EXCLUSIVE on the job and intent tables: wait at most 5 s behind a running worker, then
-- fail and re-run (plan §4: drain the check-run poller first). The runner applies each file in one transaction.
SET LOCAL lock_timeout='5s';
ALTER TABLE control_audit_job_intents DROP CONSTRAINT IF EXISTS control_audit_job_intents_kind_check;
ALTER TABLE control_audit_job_intents ADD CONSTRAINT control_audit_job_intents_kind_check
 CHECK(kind IN('audit_snapshot','audit_export','audit_compare','audit_check_run'));
ALTER TABLE control_audit_jobs ADD COLUMN IF NOT EXISTS result_check_run_id uuid;
ALTER TABLE control_audit_jobs DROP CONSTRAINT IF EXISTS control_audit_jobs_result_check;
ALTER TABLE control_audit_jobs ADD CONSTRAINT control_audit_jobs_result_check
 CHECK(num_nonnulls(result_snapshot_id,result_export_id,result_comparison_id,result_check_run_id)<=1
  AND ((state='succeeded')=(num_nonnulls(result_snapshot_id,result_export_id,result_comparison_id,result_check_run_id)=1)));
ALTER TABLE control_audit_jobs DROP CONSTRAINT IF EXISTS control_audit_jobs_check_run_identity_check;
ALTER TABLE control_audit_jobs ADD CONSTRAINT control_audit_jobs_check_run_identity_check CHECK(result_check_run_id IS NULL OR result_check_run_id=job_id);
GRANT UPDATE(result_check_run_id) ON control_audit_jobs TO app_user;

-- No monetary or entity column: totals, coverage, missing sources and digests live in the sealed header.
CREATE TABLE IF NOT EXISTS control_audit_check_results (
 company_id uuid NOT NULL,job_id uuid NOT NULL,generation bigint NOT NULL CHECK(generation>0),lease_id uuid NOT NULL,
 check_id text NOT NULL CHECK(check_id='journal_risk_checks'),
 status text NOT NULL CHECK(status IN('pass','fail','unknown')),
 population_count integer NOT NULL CHECK(population_count>=0),
 excluded_count integer NOT NULL CHECK(excluded_count>=0),
 finding_count integer NOT NULL CHECK(finding_count BETWEEN 0 AND 1000000),
 snapshot_text text NOT NULL CHECK(snapshot_text ~ '^[0-9]+:[0-9]+:[0-9,]*$' AND length(snapshot_text)<=65536),
 capture_xid text NOT NULL CHECK(capture_xid ~ '^[0-9]{1,20}$'),
 captured_at timestamptz NOT NULL,
 protected_header jsonb NOT NULL CHECK(jsonb_typeof(protected_header)='object' AND octet_length(protected_header::text)<=65536),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(company_id,job_id,generation),FOREIGN KEY(company_id,job_id) REFERENCES control_audit_jobs(company_id,job_id),
 CONSTRAINT control_audit_check_results_unknown_check CHECK(status<>'unknown' OR finding_count=0)
);
CREATE TABLE IF NOT EXISTS control_audit_check_findings (
 company_id uuid NOT NULL,job_id uuid NOT NULL,generation bigint NOT NULL CHECK(generation>0),lease_id uuid NOT NULL,
 ordinal integer NOT NULL CHECK(ordinal BETWEEN 0 AND 999999),
 finding_key text NOT NULL CHECK(finding_key ~ '^[a-f0-9]{64}$'),
 protected_item jsonb NOT NULL CHECK(jsonb_typeof(protected_item)='object' AND octet_length(protected_item::text)<=65536),
 PRIMARY KEY(company_id,job_id,generation,ordinal),UNIQUE(company_id,job_id,generation,finding_key),
 FOREIGN KEY(company_id,job_id) REFERENCES control_audit_jobs(company_id,job_id)
);
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='control_audit_jobs'::regclass AND conname='control_audit_jobs_check_run_result_fk') THEN
  ALTER TABLE control_audit_jobs ADD CONSTRAINT control_audit_jobs_check_run_result_fk
   FOREIGN KEY(company_id,result_check_run_id,generation) REFERENCES control_audit_check_results(company_id,job_id,generation);
 END IF;
END $$;

ALTER TABLE control_audit_check_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_audit_check_results FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_read ON control_audit_check_results;
CREATE POLICY tenant_read ON control_audit_check_results FOR SELECT
 USING(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()));
DROP POLICY IF EXISTS current_check_run_worker ON control_audit_check_results;
CREATE POLICY current_check_run_worker ON control_audit_check_results FOR INSERT
 WITH CHECK(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()) AND EXISTS(
  SELECT 1 FROM control_audit_jobs j JOIN control_audit_job_intents i ON i.company_id=j.company_id AND i.id=j.job_id
  WHERE j.company_id=control_audit_check_results.company_id AND j.job_id=control_audit_check_results.job_id
   AND j.generation=control_audit_check_results.generation AND j.lease_id=control_audit_check_results.lease_id
   AND j.state='running' AND j.lease_expires_at>clock_timestamp()
   AND i.kind='audit_check_run' AND i.requester_person_id=auth.uid()::text));
REVOKE ALL ON control_audit_check_results FROM PUBLIC,app_user;
GRANT SELECT,INSERT ON control_audit_check_results TO app_user;

ALTER TABLE control_audit_check_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_audit_check_findings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_read ON control_audit_check_findings;
CREATE POLICY tenant_read ON control_audit_check_findings FOR SELECT
 USING(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()));
DROP POLICY IF EXISTS current_check_run_worker ON control_audit_check_findings;
CREATE POLICY current_check_run_worker ON control_audit_check_findings FOR INSERT
 WITH CHECK(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()) AND EXISTS(
  SELECT 1 FROM control_audit_jobs j JOIN control_audit_job_intents i ON i.company_id=j.company_id AND i.id=j.job_id
  WHERE j.company_id=control_audit_check_findings.company_id AND j.job_id=control_audit_check_findings.job_id
   AND j.generation=control_audit_check_findings.generation AND j.lease_id=control_audit_check_findings.lease_id
   AND j.state='running' AND j.lease_expires_at>clock_timestamp()
   AND i.kind='audit_check_run' AND i.requester_person_id=auth.uid()::text));
REVOKE ALL ON control_audit_check_findings FROM PUBLIC,app_user;
GRANT SELECT,INSERT ON control_audit_check_findings TO app_user;
-- Append-only: no mutation privilege for the application role (as 673).
REVOKE UPDATE,DELETE ON control_audit_check_results,control_audit_check_findings FROM app_user;

-- Guards only this migration's own result: it fails 680 if, after its re-adds, the result check omits any result_%_id
-- column present at that moment or the kind check omits a contract kind. It cannot catch a LATER migration that
-- narrows either constraint, since it runs only when 680 runs. That guard is the merge-time grep (plan v6 A18):
-- every ADD CONSTRAINT of either name under scripts/migrations/sql on any branch must be 662, 668 or 680.
DO $$ DECLARE definition text; missing text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint
  WHERE conrelid='control_audit_jobs'::regclass AND conname='control_audit_jobs_result_check';
 SELECT string_agg(c.column_name,',') INTO missing FROM information_schema.columns c
  JOIN pg_class t ON t.oid='control_audit_jobs'::regclass JOIN pg_namespace n ON n.oid=t.relnamespace
  WHERE c.table_schema=n.nspname AND c.table_name='control_audit_jobs' AND c.column_name LIKE 'result\_%\_id'
   AND position(c.column_name IN coalesce(definition,''))=0;
 IF definition IS NULL OR missing IS NOT NULL THEN
  RAISE EXCEPTION 'control_audit_jobs_result_check does not name result columns: %',coalesce(missing,'constraint missing');
 END IF;
 SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint
  WHERE conrelid='control_audit_job_intents'::regclass AND conname='control_audit_job_intents_kind_check';
 SELECT string_agg(k,',') INTO missing FROM unnest(ARRAY['audit_snapshot','audit_export','audit_compare','audit_check_run']) k
  WHERE position(quote_literal(k) IN coalesce(definition,''))=0;
 IF definition IS NULL OR missing IS NOT NULL THEN
  RAISE EXCEPTION 'control_audit_job_intents_kind_check does not name kinds: %',coalesce(missing,'constraint missing');
 END IF;
END $$;
