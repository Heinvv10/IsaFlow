-- Export delivery extends the existing authenticated job queue; staging is generation-bound.
ALTER TABLE control_audit_job_intents DROP CONSTRAINT IF EXISTS control_audit_job_intents_kind_check;
ALTER TABLE control_audit_job_intents ADD CONSTRAINT control_audit_job_intents_kind_check CHECK(kind IN ('audit_snapshot','audit_export'));
ALTER TABLE control_audit_jobs ADD COLUMN IF NOT EXISTS result_export_id uuid;
ALTER TABLE control_audit_jobs DROP CONSTRAINT IF EXISTS control_audit_jobs_check2;
ALTER TABLE control_audit_jobs DROP CONSTRAINT IF EXISTS control_audit_jobs_result_check;
ALTER TABLE control_audit_jobs ADD CONSTRAINT control_audit_jobs_result_check
 CHECK(num_nonnulls(result_snapshot_id,result_export_id)<=1 AND ((state='succeeded')=(num_nonnulls(result_snapshot_id,result_export_id)=1)));
GRANT UPDATE(result_export_id) ON control_audit_jobs TO app_user;

CREATE TABLE IF NOT EXISTS control_audit_export_results (
 company_id uuid NOT NULL,job_id uuid NOT NULL,generation bigint NOT NULL CHECK(generation>0),lease_id uuid NOT NULL,
 protected_header jsonb NOT NULL CHECK(jsonb_typeof(protected_header)='object' AND octet_length(protected_header::text)<=65536),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(company_id,job_id,generation),
 FOREIGN KEY(company_id,job_id) REFERENCES control_audit_jobs(company_id,job_id)
);
CREATE TABLE IF NOT EXISTS control_audit_export_files (
 company_id uuid NOT NULL,job_id uuid NOT NULL,generation bigint NOT NULL CHECK(generation>0),lease_id uuid NOT NULL,
 file_ordinal integer NOT NULL CHECK(file_ordinal BETWEEN 0 AND 100005),
 protected_file jsonb NOT NULL CHECK(jsonb_typeof(protected_file)='object' AND octet_length(protected_file::text)<=65536),
 PRIMARY KEY(company_id,job_id,generation,file_ordinal),
 FOREIGN KEY(company_id,job_id) REFERENCES control_audit_jobs(company_id,job_id)
);
CREATE TABLE IF NOT EXISTS control_audit_export_chunks (
 company_id uuid NOT NULL,job_id uuid NOT NULL,generation bigint NOT NULL CHECK(generation>0),lease_id uuid NOT NULL,
 file_ordinal integer NOT NULL,chunk_ordinal integer NOT NULL CHECK(chunk_ordinal BETWEEN 0 AND 4095),
 protected_chunk jsonb NOT NULL CHECK(jsonb_typeof(protected_chunk)='object' AND octet_length(protected_chunk::text)<=1048576),
 PRIMARY KEY(company_id,job_id,generation,file_ordinal,chunk_ordinal),
 FOREIGN KEY(company_id,job_id,generation,file_ordinal) REFERENCES control_audit_export_files(company_id,job_id,generation,file_ordinal)
);
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='control_audit_jobs'::regclass AND conname='control_audit_jobs_export_result_fk') THEN
  ALTER TABLE control_audit_jobs ADD CONSTRAINT control_audit_jobs_export_result_fk
   FOREIGN KEY(company_id,result_export_id,generation) REFERENCES control_audit_export_results(company_id,job_id,generation);
 END IF;
END $$;

ALTER TABLE control_audit_export_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_audit_export_results FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_read ON control_audit_export_results;
CREATE POLICY tenant_read ON control_audit_export_results FOR SELECT
 USING(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()));
DROP POLICY IF EXISTS current_export_worker ON control_audit_export_results;
CREATE POLICY current_export_worker ON control_audit_export_results FOR INSERT
 WITH CHECK(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()) AND EXISTS(
  SELECT 1 FROM control_audit_jobs j JOIN control_audit_job_intents i ON i.company_id=j.company_id AND i.id=j.job_id
  WHERE j.company_id=control_audit_export_results.company_id AND j.job_id=control_audit_export_results.job_id
   AND j.generation=control_audit_export_results.generation AND j.lease_id=control_audit_export_results.lease_id
   AND j.state='running' AND j.lease_expires_at>clock_timestamp()
   AND i.kind='audit_export' AND i.requester_person_id=auth.uid()::text));
REVOKE ALL ON control_audit_export_results FROM PUBLIC,app_user;
GRANT SELECT,INSERT ON control_audit_export_results TO app_user;

ALTER TABLE control_audit_export_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_audit_export_files FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_read ON control_audit_export_files;
CREATE POLICY tenant_read ON control_audit_export_files FOR SELECT
 USING(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()));
DROP POLICY IF EXISTS current_export_worker ON control_audit_export_files;
CREATE POLICY current_export_worker ON control_audit_export_files FOR INSERT
 WITH CHECK(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()) AND EXISTS(
  SELECT 1 FROM control_audit_jobs j JOIN control_audit_job_intents i ON i.company_id=j.company_id AND i.id=j.job_id
  WHERE j.company_id=control_audit_export_files.company_id AND j.job_id=control_audit_export_files.job_id
   AND j.generation=control_audit_export_files.generation AND j.lease_id=control_audit_export_files.lease_id
   AND j.state='running' AND j.lease_expires_at>clock_timestamp()
   AND i.kind='audit_export' AND i.requester_person_id=auth.uid()::text));
REVOKE ALL ON control_audit_export_files FROM PUBLIC,app_user;
GRANT SELECT,INSERT ON control_audit_export_files TO app_user;

ALTER TABLE control_audit_export_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_audit_export_chunks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_read ON control_audit_export_chunks;
CREATE POLICY tenant_read ON control_audit_export_chunks FOR SELECT
 USING(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()));
DROP POLICY IF EXISTS current_export_worker ON control_audit_export_chunks;
CREATE POLICY current_export_worker ON control_audit_export_chunks FOR INSERT
 WITH CHECK(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()) AND EXISTS(
  SELECT 1 FROM control_audit_jobs j JOIN control_audit_job_intents i ON i.company_id=j.company_id AND i.id=j.job_id
  WHERE j.company_id=control_audit_export_chunks.company_id AND j.job_id=control_audit_export_chunks.job_id
   AND j.generation=control_audit_export_chunks.generation AND j.lease_id=control_audit_export_chunks.lease_id
   AND j.state='running' AND j.lease_expires_at>clock_timestamp()
   AND i.kind='audit_export' AND i.requester_person_id=auth.uid()::text));
REVOKE ALL ON control_audit_export_chunks FROM PUBLIC,app_user;
GRANT SELECT,INSERT ON control_audit_export_chunks TO app_user;
