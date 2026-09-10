-- Retained historical indexes keep unknown lineage; every new index requires a live worker.
ALTER TABLE control_audit_snapshot_indexes ADD COLUMN IF NOT EXISTS build_job_id uuid;
ALTER TABLE control_audit_snapshot_indexes ADD COLUMN IF NOT EXISTS build_generation bigint;
ALTER TABLE control_audit_snapshot_indexes ADD COLUMN IF NOT EXISTS build_lease_id uuid;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='control_audit_snapshot_indexes'::regclass AND conname='snapshot_index_build_lineage') THEN
  ALTER TABLE control_audit_snapshot_indexes ADD CONSTRAINT snapshot_index_build_lineage
   CHECK((build_job_id IS NULL AND build_generation IS NULL AND build_lease_id IS NULL)
    OR(build_job_id IS NOT NULL AND build_generation IS NOT NULL AND build_generation>0 AND build_lease_id IS NOT NULL));
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='control_audit_snapshot_indexes'::regclass AND conname='snapshot_index_build_job') THEN
  ALTER TABLE control_audit_snapshot_indexes ADD CONSTRAINT snapshot_index_build_job
   FOREIGN KEY(company_id,build_job_id) REFERENCES control_audit_job_intents(company_id,id);
 END IF;
END $$;
DROP POLICY IF EXISTS tenant_create ON control_audit_snapshot_indexes;
CREATE POLICY tenant_create ON control_audit_snapshot_indexes FOR INSERT
 WITH CHECK(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies())
  AND build_job_id IS NOT NULL AND build_generation IS NOT NULL AND build_lease_id IS NOT NULL
  AND EXISTS(SELECT 1 FROM control_audit_jobs j JOIN control_audit_job_intents i ON i.company_id=j.company_id AND i.id=j.job_id
   WHERE j.company_id=control_audit_snapshot_indexes.company_id AND j.job_id=control_audit_snapshot_indexes.build_job_id
    AND j.state='running' AND j.generation=control_audit_snapshot_indexes.build_generation
    AND j.lease_id=control_audit_snapshot_indexes.build_lease_id AND j.lease_expires_at>clock_timestamp()
    AND i.requester_person_id=auth.uid()::text
    AND(i.kind='audit_compare' OR(i.kind='audit_snapshot' AND j.job_id=control_audit_snapshot_indexes.snapshot_id))));
DROP POLICY IF EXISTS tenant_create ON control_audit_snapshot_index_items;
CREATE POLICY tenant_create ON control_audit_snapshot_index_items FOR INSERT
 WITH CHECK(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies())
  AND EXISTS(SELECT 1 FROM control_audit_snapshot_indexes h
   JOIN control_audit_jobs j ON j.company_id=h.company_id AND j.job_id=h.build_job_id
   JOIN control_audit_job_intents i ON i.company_id=j.company_id AND i.id=j.job_id
   WHERE h.company_id=control_audit_snapshot_index_items.company_id AND h.snapshot_id=control_audit_snapshot_index_items.snapshot_id
    AND j.state='running' AND j.generation=h.build_generation AND j.lease_id=h.build_lease_id
    AND j.lease_expires_at>clock_timestamp() AND i.requester_person_id=auth.uid()::text));
DROP POLICY IF EXISTS tenant_create ON control_audit_snapshot_index_chunks;
CREATE POLICY tenant_create ON control_audit_snapshot_index_chunks FOR INSERT
 WITH CHECK(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies())
  AND EXISTS(SELECT 1 FROM control_audit_snapshot_indexes h
   JOIN control_audit_jobs j ON j.company_id=h.company_id AND j.job_id=h.build_job_id
   JOIN control_audit_job_intents i ON i.company_id=j.company_id AND i.id=j.job_id
   WHERE h.company_id=control_audit_snapshot_index_chunks.company_id AND h.snapshot_id=control_audit_snapshot_index_chunks.snapshot_id
    AND j.state='running' AND j.generation=h.build_generation AND j.lease_id=h.build_lease_id
    AND j.lease_expires_at>clock_timestamp() AND i.requester_person_id=auth.uid()::text));
-- No new mutation privileges, defaults or synthetic historical attribution.
REVOKE UPDATE,DELETE ON control_audit_snapshot_indexes,control_audit_snapshot_index_items,control_audit_snapshot_index_chunks FROM app_user;
