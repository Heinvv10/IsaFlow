-- Durable audit requests are immutable; worker status never replaces request authority.
CREATE TABLE IF NOT EXISTS control_audit_job_intents (
 company_id uuid NOT NULL REFERENCES companies(id),id uuid NOT NULL DEFAULT gen_random_uuid(),
 requester_person_id text NOT NULL REFERENCES users(id),kind text NOT NULL CHECK(kind='audit_snapshot'),
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128),
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 protected_request jsonb NOT NULL CHECK(jsonb_typeof(protected_request)='object'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(company_id,id),
 UNIQUE(company_id,requester_person_id,kind,idempotency_key)
);
CREATE TABLE IF NOT EXISTS control_audit_jobs (
 company_id uuid NOT NULL REFERENCES companies(id),job_id uuid NOT NULL,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN('queued','running','succeeded','failed')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
 generation bigint NOT NULL DEFAULT 0 CHECK(generation>=0),lease_id uuid,lease_expires_at timestamptz,
 result_snapshot_id uuid,last_error_code text CHECK(length(last_error_code)<=64),
 started_at timestamptz,completed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(company_id,job_id),FOREIGN KEY(company_id,job_id) REFERENCES control_audit_job_intents(company_id,id),
 CHECK((state='running')=(lease_id IS NOT NULL AND lease_expires_at IS NOT NULL)),
 CHECK((lease_id IS NULL)=(lease_expires_at IS NULL)),
 CHECK((state='succeeded')=(result_snapshot_id IS NOT NULL)),
 CHECK((state IN('succeeded','failed'))=(completed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS control_audit_jobs_claim ON control_audit_jobs(company_id,state,lease_expires_at,created_at,job_id);
ALTER TABLE control_audit_job_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_audit_job_intents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_read ON control_audit_job_intents;
CREATE POLICY tenant_read ON control_audit_job_intents FOR SELECT
 USING(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()));
DROP POLICY IF EXISTS tenant_create ON control_audit_job_intents;
CREATE POLICY tenant_create ON control_audit_job_intents FOR INSERT
 WITH CHECK(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()) AND requester_person_id=auth.uid()::text);
REVOKE ALL ON control_audit_job_intents FROM PUBLIC,app_user;
GRANT SELECT,INSERT ON control_audit_job_intents TO app_user;
ALTER TABLE control_audit_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_audit_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_read ON control_audit_jobs;
CREATE POLICY tenant_read ON control_audit_jobs FOR SELECT
 USING(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()));
DROP POLICY IF EXISTS tenant_create ON control_audit_jobs;
CREATE POLICY tenant_create ON control_audit_jobs FOR INSERT
 WITH CHECK(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()) AND EXISTS(
  SELECT 1 FROM control_audit_job_intents i WHERE i.company_id=control_audit_jobs.company_id AND i.id=control_audit_jobs.job_id AND i.requester_person_id=auth.uid()::text));
DROP POLICY IF EXISTS tenant_worker ON control_audit_jobs;
CREATE POLICY tenant_worker ON control_audit_jobs FOR UPDATE
 USING(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()) AND EXISTS(
  SELECT 1 FROM control_audit_job_intents i WHERE i.company_id=control_audit_jobs.company_id AND i.id=control_audit_jobs.job_id AND i.requester_person_id=auth.uid()::text))
 WITH CHECK(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()) AND EXISTS(
  SELECT 1 FROM control_audit_job_intents i WHERE i.company_id=control_audit_jobs.company_id AND i.id=control_audit_jobs.job_id AND i.requester_person_id=auth.uid()::text));
REVOKE ALL ON control_audit_jobs FROM PUBLIC,app_user;
GRANT SELECT,INSERT ON control_audit_jobs TO app_user;
GRANT UPDATE(state,attempts,generation,lease_id,lease_expires_at,result_snapshot_id,last_error_code,started_at,completed_at,updated_at) ON control_audit_jobs TO app_user;
