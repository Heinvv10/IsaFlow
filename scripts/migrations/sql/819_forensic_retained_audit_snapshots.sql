-- Protected complete snapshot and artifact bytes; append-only to application principals.
CREATE TABLE IF NOT EXISTS control_audit_snapshots (
 company_id uuid NOT NULL REFERENCES companies(id),id uuid NOT NULL,job_id uuid NOT NULL,
 requester_person_id text NOT NULL REFERENCES users(id),cutoff date NOT NULL,
 canonical_hash text NOT NULL CHECK(canonical_hash ~ '^[a-f0-9]{64}$'),
 protected_snapshot jsonb NOT NULL CHECK(jsonb_typeof(protected_snapshot)='object'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(company_id,id),UNIQUE(company_id,job_id),
 FOREIGN KEY(company_id,job_id) REFERENCES control_audit_job_intents(company_id,id),CHECK(id=job_id)
);
CREATE TABLE IF NOT EXISTS control_audit_snapshot_artifacts (
 company_id uuid NOT NULL REFERENCES companies(id),snapshot_id uuid NOT NULL,
 artifact_id text NOT NULL CHECK(length(artifact_id) BETWEEN 1 AND 256),
 protected_artifact jsonb NOT NULL CHECK(jsonb_typeof(protected_artifact)='object'),
 PRIMARY KEY(company_id,snapshot_id,artifact_id),FOREIGN KEY(company_id,snapshot_id) REFERENCES control_audit_snapshots(company_id,id)
);
ALTER TABLE control_audit_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_audit_snapshots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_read ON control_audit_snapshots;
CREATE POLICY tenant_read ON control_audit_snapshots FOR SELECT
 USING(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()));
DROP POLICY IF EXISTS tenant_create ON control_audit_snapshots;
CREATE POLICY tenant_create ON control_audit_snapshots FOR INSERT
 WITH CHECK(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()) AND requester_person_id=auth.uid()::text
  AND EXISTS(SELECT 1 FROM control_audit_job_intents i WHERE i.company_id=control_audit_snapshots.company_id AND i.id=control_audit_snapshots.job_id AND i.requester_person_id=auth.uid()::text));
ALTER TABLE control_audit_snapshot_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_audit_snapshot_artifacts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_read ON control_audit_snapshot_artifacts;
CREATE POLICY tenant_read ON control_audit_snapshot_artifacts FOR SELECT
 USING(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()));
DROP POLICY IF EXISTS tenant_create ON control_audit_snapshot_artifacts;
CREATE POLICY tenant_create ON control_audit_snapshot_artifacts FOR INSERT
 WITH CHECK(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies())
  AND EXISTS(SELECT 1 FROM control_audit_snapshots s WHERE s.company_id=control_audit_snapshot_artifacts.company_id AND s.id=control_audit_snapshot_artifacts.snapshot_id AND s.requester_person_id=auth.uid()::text));
REVOKE ALL ON control_audit_snapshots,control_audit_snapshot_artifacts FROM PUBLIC,app_user;
GRANT SELECT,INSERT ON control_audit_snapshots,control_audit_snapshot_artifacts TO app_user;
