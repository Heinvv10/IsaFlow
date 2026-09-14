-- Bounded immutable index of authenticated retained material; no foreground source scan.
CREATE TABLE IF NOT EXISTS control_audit_snapshot_indexes (
 company_id uuid NOT NULL,snapshot_id uuid NOT NULL,
 protected_header jsonb NOT NULL CHECK(jsonb_typeof(protected_header)='object' AND octet_length(protected_header::text)<=65536),
 PRIMARY KEY(company_id,snapshot_id),
 FOREIGN KEY(company_id,snapshot_id) REFERENCES control_audit_snapshots(company_id,id)
);
CREATE TABLE IF NOT EXISTS control_audit_snapshot_index_items (
 company_id uuid NOT NULL,snapshot_id uuid NOT NULL,
 section text NOT NULL CHECK(section IN('records','checks','findings','evidence','gaps')),
 ordinal integer NOT NULL CHECK(ordinal BETWEEN 0 AND 800005),
 protected_item jsonb NOT NULL CHECK(jsonb_typeof(protected_item)='object' AND octet_length(protected_item::text)<=65536),
 PRIMARY KEY(company_id,snapshot_id,section,ordinal),
 FOREIGN KEY(company_id,snapshot_id) REFERENCES control_audit_snapshot_indexes(company_id,snapshot_id)
);
CREATE TABLE IF NOT EXISTS control_audit_snapshot_index_chunks (
 company_id uuid NOT NULL,snapshot_id uuid NOT NULL,section text NOT NULL,ordinal integer NOT NULL,
 chunk_ordinal integer NOT NULL CHECK(chunk_ordinal BETWEEN 0 AND 1023),
 protected_chunk jsonb NOT NULL CHECK(jsonb_typeof(protected_chunk)='object' AND octet_length(protected_chunk::text)<=1048576),
 PRIMARY KEY(company_id,snapshot_id,section,ordinal,chunk_ordinal),
 FOREIGN KEY(company_id,snapshot_id,section,ordinal) REFERENCES control_audit_snapshot_index_items(company_id,snapshot_id,section,ordinal)
);
ALTER TABLE control_audit_snapshot_indexes ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_audit_snapshot_indexes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_read ON control_audit_snapshot_indexes;
CREATE POLICY tenant_read ON control_audit_snapshot_indexes FOR SELECT
 USING(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()));
DROP POLICY IF EXISTS tenant_create ON control_audit_snapshot_indexes;
CREATE POLICY tenant_create ON control_audit_snapshot_indexes FOR INSERT
 WITH CHECK(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies())
  AND EXISTS(SELECT 1 FROM control_audit_snapshots s WHERE s.company_id=control_audit_snapshot_indexes.company_id
   AND s.id=control_audit_snapshot_indexes.snapshot_id AND s.requester_person_id=auth.uid()::text));
REVOKE ALL ON control_audit_snapshot_indexes FROM PUBLIC,app_user;
GRANT SELECT,INSERT ON control_audit_snapshot_indexes TO app_user;
ALTER TABLE control_audit_snapshot_index_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_audit_snapshot_index_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_read ON control_audit_snapshot_index_items;
CREATE POLICY tenant_read ON control_audit_snapshot_index_items FOR SELECT
 USING(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()));
DROP POLICY IF EXISTS tenant_create ON control_audit_snapshot_index_items;
CREATE POLICY tenant_create ON control_audit_snapshot_index_items FOR INSERT
 WITH CHECK(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies())
  AND EXISTS(SELECT 1 FROM control_audit_snapshots s WHERE s.company_id=control_audit_snapshot_index_items.company_id
   AND s.id=control_audit_snapshot_index_items.snapshot_id AND s.requester_person_id=auth.uid()::text));
REVOKE ALL ON control_audit_snapshot_index_items FROM PUBLIC,app_user;
GRANT SELECT,INSERT ON control_audit_snapshot_index_items TO app_user;
ALTER TABLE control_audit_snapshot_index_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_audit_snapshot_index_chunks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_read ON control_audit_snapshot_index_chunks;
CREATE POLICY tenant_read ON control_audit_snapshot_index_chunks FOR SELECT
 USING(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()));
DROP POLICY IF EXISTS tenant_create ON control_audit_snapshot_index_chunks;
CREATE POLICY tenant_create ON control_audit_snapshot_index_chunks FOR INSERT
 WITH CHECK(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies())
  AND EXISTS(SELECT 1 FROM control_audit_snapshots s WHERE s.company_id=control_audit_snapshot_index_chunks.company_id
   AND s.id=control_audit_snapshot_index_chunks.snapshot_id AND s.requester_person_id=auth.uid()::text));
REVOKE ALL ON control_audit_snapshot_index_chunks FROM PUBLIC,app_user;
GRANT SELECT,INSERT ON control_audit_snapshot_index_chunks TO app_user;
