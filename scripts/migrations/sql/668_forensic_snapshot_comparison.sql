-- Authenticated comparison projections and generation-bound results; ciphertext is not read authority.
ALTER TABLE control_audit_job_intents DROP CONSTRAINT IF EXISTS control_audit_job_intents_kind_check;
ALTER TABLE control_audit_job_intents ADD CONSTRAINT control_audit_job_intents_kind_check CHECK(kind IN('audit_snapshot','audit_export','audit_compare'));
ALTER TABLE control_audit_jobs ADD COLUMN IF NOT EXISTS result_comparison_id uuid;
ALTER TABLE control_audit_jobs DROP CONSTRAINT IF EXISTS control_audit_jobs_result_check;
ALTER TABLE control_audit_jobs ADD CONSTRAINT control_audit_jobs_result_check
 CHECK(num_nonnulls(result_snapshot_id,result_export_id,result_comparison_id)<=1
  AND ((state='succeeded')=(num_nonnulls(result_snapshot_id,result_export_id,result_comparison_id)=1)));
ALTER TABLE control_audit_jobs DROP CONSTRAINT IF EXISTS control_audit_jobs_comparison_identity_check;
ALTER TABLE control_audit_jobs ADD CONSTRAINT control_audit_jobs_comparison_identity_check CHECK(result_comparison_id IS NULL OR result_comparison_id=job_id);
GRANT UPDATE(result_comparison_id) ON control_audit_jobs TO app_user;
CREATE TABLE IF NOT EXISTS control_audit_comparison_sources (
 company_id uuid NOT NULL,snapshot_id uuid NOT NULL,
 build_job_id uuid NOT NULL,build_generation bigint NOT NULL CHECK(build_generation>0),build_lease_id uuid NOT NULL,
 protected_header jsonb NOT NULL CHECK(jsonb_typeof(protected_header)='object' AND octet_length(protected_header::text)<=65536),
 PRIMARY KEY(company_id,snapshot_id),UNIQUE(company_id,snapshot_id,build_job_id,build_generation,build_lease_id),
 FOREIGN KEY(company_id,snapshot_id) REFERENCES control_audit_snapshots(company_id,id),
 FOREIGN KEY(company_id,build_job_id) REFERENCES control_audit_jobs(company_id,job_id)
);
CREATE TABLE IF NOT EXISTS control_audit_comparison_source_items (
 company_id uuid NOT NULL,snapshot_id uuid NOT NULL,
 build_job_id uuid NOT NULL,build_generation bigint NOT NULL CHECK(build_generation>0),build_lease_id uuid NOT NULL,
 section text NOT NULL CHECK(section IN('records','checks','evidence','evidenceGaps')),
 position integer NOT NULL CHECK(position BETWEEN 0 AND 99999),
 protected_item jsonb NOT NULL CHECK(jsonb_typeof(protected_item)='object' AND octet_length(protected_item::text)<=65536),
 PRIMARY KEY(company_id,snapshot_id,section,position),
 FOREIGN KEY(company_id,snapshot_id,build_job_id,build_generation,build_lease_id)
  REFERENCES control_audit_comparison_sources(company_id,snapshot_id,build_job_id,build_generation,build_lease_id)
);
CREATE TABLE IF NOT EXISTS control_audit_comparison_results (
 company_id uuid NOT NULL,job_id uuid NOT NULL,generation bigint NOT NULL CHECK(generation>0),lease_id uuid NOT NULL,
 protected_header jsonb NOT NULL CHECK(jsonb_typeof(protected_header)='object' AND octet_length(protected_header::text)<=65536),
 PRIMARY KEY(company_id,job_id,generation),FOREIGN KEY(company_id,job_id) REFERENCES control_audit_jobs(company_id,job_id)
);
-- Output can contain all disjoint inputs, not merely the input's 100000-record limit.
CREATE TABLE IF NOT EXISTS control_audit_comparison_items (
 company_id uuid NOT NULL,job_id uuid NOT NULL,generation bigint NOT NULL CHECK(generation>0),lease_id uuid NOT NULL,
 section text NOT NULL CHECK(section IN('records','checks','evidence','evidenceGaps')),
 position integer NOT NULL CHECK(position BETWEEN 0 AND 200011),
 protected_item jsonb NOT NULL CHECK(jsonb_typeof(protected_item)='object' AND octet_length(protected_item::text)<=65536),
 PRIMARY KEY(company_id,job_id,generation,section,position),
 FOREIGN KEY(company_id,job_id) REFERENCES control_audit_jobs(company_id,job_id)
);
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='control_audit_jobs'::regclass AND conname='control_audit_jobs_comparison_result_fk') THEN
  ALTER TABLE control_audit_jobs ADD CONSTRAINT control_audit_jobs_comparison_result_fk
   FOREIGN KEY(company_id,result_comparison_id,generation) REFERENCES control_audit_comparison_results(company_id,job_id,generation);
 END IF;
END $$;

ALTER TABLE control_audit_comparison_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_audit_comparison_sources FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_read ON control_audit_comparison_sources;
CREATE POLICY tenant_read ON control_audit_comparison_sources FOR SELECT
 USING(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()));
DROP POLICY IF EXISTS current_comparison_worker ON control_audit_comparison_sources;
CREATE POLICY current_comparison_worker ON control_audit_comparison_sources FOR INSERT
 WITH CHECK(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()) AND EXISTS(
  SELECT 1 FROM control_audit_jobs j JOIN control_audit_job_intents i ON i.company_id=j.company_id AND i.id=j.job_id
  WHERE j.company_id=control_audit_comparison_sources.company_id AND j.job_id=control_audit_comparison_sources.build_job_id
   AND j.generation=control_audit_comparison_sources.build_generation AND j.lease_id=control_audit_comparison_sources.build_lease_id
   AND j.state='running' AND j.lease_expires_at>clock_timestamp()
   AND i.kind IN('audit_snapshot','audit_compare') AND i.requester_person_id=auth.uid()::text));
REVOKE ALL ON control_audit_comparison_sources FROM PUBLIC,app_user;
GRANT SELECT,INSERT ON control_audit_comparison_sources TO app_user;

ALTER TABLE control_audit_comparison_source_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_audit_comparison_source_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_read ON control_audit_comparison_source_items;
CREATE POLICY tenant_read ON control_audit_comparison_source_items FOR SELECT
 USING(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()));
DROP POLICY IF EXISTS current_comparison_worker ON control_audit_comparison_source_items;
CREATE POLICY current_comparison_worker ON control_audit_comparison_source_items FOR INSERT
 WITH CHECK(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()) AND EXISTS(
  SELECT 1 FROM control_audit_jobs j JOIN control_audit_job_intents i ON i.company_id=j.company_id AND i.id=j.job_id
  WHERE j.company_id=control_audit_comparison_source_items.company_id AND j.job_id=control_audit_comparison_source_items.build_job_id
   AND j.generation=control_audit_comparison_source_items.build_generation AND j.lease_id=control_audit_comparison_source_items.build_lease_id
   AND j.state='running' AND j.lease_expires_at>clock_timestamp()
   AND i.kind IN('audit_snapshot','audit_compare') AND i.requester_person_id=auth.uid()::text));
REVOKE ALL ON control_audit_comparison_source_items FROM PUBLIC,app_user;
GRANT SELECT,INSERT ON control_audit_comparison_source_items TO app_user;

ALTER TABLE control_audit_comparison_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_audit_comparison_results FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_read ON control_audit_comparison_results;
CREATE POLICY tenant_read ON control_audit_comparison_results FOR SELECT
 USING(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()));
DROP POLICY IF EXISTS current_comparison_worker ON control_audit_comparison_results;
CREATE POLICY current_comparison_worker ON control_audit_comparison_results FOR INSERT
 WITH CHECK(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()) AND EXISTS(
  SELECT 1 FROM control_audit_jobs j JOIN control_audit_job_intents i ON i.company_id=j.company_id AND i.id=j.job_id
  WHERE j.company_id=control_audit_comparison_results.company_id AND j.job_id=control_audit_comparison_results.job_id
   AND j.generation=control_audit_comparison_results.generation AND j.lease_id=control_audit_comparison_results.lease_id
   AND j.state='running' AND j.lease_expires_at>clock_timestamp()
   AND i.kind='audit_compare' AND i.requester_person_id=auth.uid()::text));
REVOKE ALL ON control_audit_comparison_results FROM PUBLIC,app_user;
GRANT SELECT,INSERT ON control_audit_comparison_results TO app_user;

ALTER TABLE control_audit_comparison_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_audit_comparison_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_read ON control_audit_comparison_items;
CREATE POLICY tenant_read ON control_audit_comparison_items FOR SELECT
 USING(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()));
DROP POLICY IF EXISTS current_comparison_worker ON control_audit_comparison_items;
CREATE POLICY current_comparison_worker ON control_audit_comparison_items FOR INSERT
 WITH CHECK(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()) AND EXISTS(
  SELECT 1 FROM control_audit_jobs j JOIN control_audit_job_intents i ON i.company_id=j.company_id AND i.id=j.job_id
  WHERE j.company_id=control_audit_comparison_items.company_id AND j.job_id=control_audit_comparison_items.job_id
   AND j.generation=control_audit_comparison_items.generation AND j.lease_id=control_audit_comparison_items.lease_id
   AND j.state='running' AND j.lease_expires_at>clock_timestamp()
   AND i.kind='audit_compare' AND i.requester_person_id=auth.uid()::text));
REVOKE ALL ON control_audit_comparison_items FROM PUBLIC,app_user;
GRANT SELECT,INSERT ON control_audit_comparison_items TO app_user;
