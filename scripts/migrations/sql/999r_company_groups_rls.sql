-- 999r: row security for the company-group tables, and a group check on who may join one.
--
-- FOUND by a live probe as app_user on a PG16 fixture built like the integration gate:
--   1. company_groups (240) had no row security: any session read every tenant's group names.
--   2. company_group_members (348/498's tenant_isolation) checked only the company: WITH CHECK
--      company_id = app.current_company_id() said nothing about group_id, so a session could insert
--      ITS OWN company into ANY group (and UPDATE group_id of its own row to move it there). Group
--      membership is becoming a trust signal (intercompany auto-accept), so joining a group must
--      prove standing in it.
--   3. The siblings had the same read gap, and the same write gap on the group:
--        group_accounts, intercompany_transactions, consolidation_adjustments (240): no row security;
--        group_coa_mappings (348/498): company-only check, any group_id accepted;
--        company_relationships, intercompany_eliminations (307): no row security (a relationship row is
--        a cross-tenant READ GRANT of the child's ledger, 532).
--
-- THE RULES (they restate the route's own guards, companyAccessService / groupRouteGuards, in the
-- database, so a path that skips the route meets them too):
--   - A group is visible to a user with a company that is a CURRENT member (left_date IS NULL) of it,
--     and to its creator (the memberless group, until it gains its first member).
--   - Group-keyed rows (group_accounts, intercompany_transactions, consolidation_adjustments,
--     group_coa_mappings) are read by those members and written by a user with a WRITE ROLE
--     (owner / admin / manager, src/lib/auth/writeRoles.ts DEFAULT_WRITE_ROLES) in a current member
--     company. A viewer reads, never writes.
--   - A company joins a group (company_group_members INSERT) only when the user writes the group (as
--     above) or is the creator of a group that has NEVER had a member row (the bootstrap: it could never
--     gain its first member otherwise), AND holds a write role in the company being added. The company
--     check stays the active company, as it was.
--   - company_group_members.group_id / company_id and company_relationships.parent / child never change
--     (a row is retired with left_date / deleted_at, never moved): a trigger, so UPDATE cannot do what
--     INSERT refuses. Nothing in the app updates them.
--   - company_relationships: read by either end; created only by the parent's active company for a
--     child the user writes; withdrawn (deleted_at set) by either end; REVIVED only by someone who
--     writes the child, so a child's withdrawal cannot be undone from the parent's side. No DELETE: the
--     row is the audit record (532).
--   - intercompany_eliminations: the parent (group_company_id) company's own rows, in 944's form.
--
-- NOT CHANGED, on purpose: a session still reads company_group_members rows of its own companies only,
-- and still writes a member row with that company active (the old WITH CHECK). Both limits predate this
-- file; widening either is a product decision.
--
-- Definers: these read rows the caller's own policy would hide (and company_group_members, whose
-- policy would recurse). Owner migration_admin (BYPASSRLS), pinned search_path with pg_temp last,
-- EXECUTE for app_user only, each with an app_definer_reviews row (930). All are reads.
-- app_service's USING (true) mirrors are re-synced at the end (915); every predicate below is a function
-- of request.jwt.claims / app.current_company_id, which s07b's census treats as forgeable.

SET LOCAL lock_timeout = '5s';

-- ── Definer helpers ──────────────────────────────────────────────────────────

-- Groups with a CURRENT member company the caller belongs to (userBelongsToGroup).
CREATE OR REPLACE FUNCTION public.rls_user_group_ids()
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT cgm.group_id
    FROM public.company_group_members cgm
    JOIN public.company_users cu ON cu.company_id = cgm.company_id
   WHERE cgm.left_date IS NULL AND cu.user_id = auth.uid()
$$;

-- The same, where the caller's role in that member company is a write role (userCanWriteGroup).
-- The role list is DEFAULT_WRITE_ROLES; tests/integration/company-groups-rls.int.test.ts pins it.
CREATE OR REPLACE FUNCTION public.rls_user_write_group_ids()
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT cgm.group_id
    FROM public.company_group_members cgm
    JOIN public.company_users cu ON cu.company_id = cgm.company_id
   WHERE cgm.left_date IS NULL AND cu.user_id = auth.uid()
     AND cu.role = ANY (ARRAY['owner', 'admin', 'manager']::pg_catalog.text[])
$$;

-- Companies where the caller holds a write role (userCanWriteCompany).
CREATE OR REPLACE FUNCTION public.rls_user_write_company_ids()
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT cu.company_id FROM public.company_users cu
   WHERE cu.user_id = auth.uid()
     AND cu.role = ANY (ARRAY['owner', 'admin', 'manager']::pg_catalog.text[])
$$;

-- The creator's bootstrap (creatorMayBootstrapGroup): the caller created the group and no company has
-- EVER been a member of it (left or not), so a creator who lost its standing cannot re-open a group.
CREATE OR REPLACE FUNCTION public.rls_group_may_bootstrap(p_group uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.company_groups g
     WHERE g.id = p_group AND g.created_by::pg_catalog.text = auth.uid()
       AND NOT EXISTS (SELECT 1 FROM public.company_group_members m WHERE m.group_id = g.id)
  )
$$;

ALTER FUNCTION public.rls_user_group_ids() OWNER TO migration_admin;
ALTER FUNCTION public.rls_user_write_group_ids() OWNER TO migration_admin;
ALTER FUNCTION public.rls_user_write_company_ids() OWNER TO migration_admin;
ALTER FUNCTION public.rls_group_may_bootstrap(uuid) OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.rls_user_group_ids() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rls_user_write_group_ids() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rls_user_write_company_ids() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rls_group_may_bootstrap(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rls_user_group_ids() TO app_user;
GRANT EXECUTE ON FUNCTION public.rls_user_write_group_ids() TO app_user;
GRANT EXECUTE ON FUNCTION public.rls_user_write_company_ids() TO app_user;
GRANT EXECUTE ON FUNCTION public.rls_group_may_bootstrap(uuid) TO app_user;

INSERT INTO public.app_definer_reviews (signature, writes, body_md5)
SELECT v.signature, 'nothing (read)', public.app_definer_hash(v.proc::regprocedure)
  FROM (VALUES
    ('rls_user_group_ids()', 'public.rls_user_group_ids()'),
    ('rls_user_write_group_ids()', 'public.rls_user_write_group_ids()'),
    ('rls_user_write_company_ids()', 'public.rls_user_write_company_ids()'),
    ('rls_group_may_bootstrap(uuid)', 'public.rls_group_may_bootstrap(uuid)')
  ) v(signature, proc)
ON CONFLICT (signature) DO UPDATE SET writes = EXCLUDED.writes, body_md5 = EXCLUDED.body_md5;

-- ── Keys that never change ───────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.company_group_member_keys_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.group_id IS DISTINCT FROM OLD.group_id OR NEW.company_id IS DISTINCT FROM OLD.company_id THEN
    RAISE EXCEPTION 'company_group_members: a member row is retired with left_date, never moved to another group or company'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_company_group_member_keys_immutable ON company_group_members;
CREATE TRIGGER trg_company_group_member_keys_immutable BEFORE UPDATE OF group_id, company_id ON company_group_members
  FOR EACH ROW EXECUTE FUNCTION public.company_group_member_keys_immutable();

CREATE OR REPLACE FUNCTION public.company_relationship_keys_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.parent_company_id IS DISTINCT FROM OLD.parent_company_id OR NEW.child_company_id IS DISTINCT FROM OLD.child_company_id THEN
    RAISE EXCEPTION 'company_relationships: a link is withdrawn with deleted_at, never re-pointed at another company'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_company_relationship_keys_immutable ON company_relationships;
CREATE TRIGGER trg_company_relationship_keys_immutable BEFORE UPDATE OF parent_company_id, child_company_id ON company_relationships
  FOR EACH ROW EXECUTE FUNCTION public.company_relationship_keys_immutable();

-- ── company_groups ───────────────────────────────────────────────────────────

ALTER TABLE company_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_groups FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON company_groups;
DROP POLICY IF EXISTS tenant_isolation_insert ON company_groups;
DROP POLICY IF EXISTS tenant_isolation_update ON company_groups;
DROP POLICY IF EXISTS tenant_isolation_delete ON company_groups;
CREATE POLICY tenant_isolation_select ON company_groups FOR SELECT TO app_user
  USING (id IN (SELECT public.rls_user_group_ids()) OR created_by::text = auth.uid());
-- A group is created in the caller's own name, and its holding company (if any) is one of the caller's.
CREATE POLICY tenant_isolation_insert ON company_groups FOR INSERT TO app_user
  WITH CHECK (created_by::text = auth.uid()
              AND (holding_company_id IS NULL OR holding_company_id IN (SELECT auth.user_companies())));
CREATE POLICY tenant_isolation_update ON company_groups FOR UPDATE TO app_user
  USING (id IN (SELECT public.rls_user_write_group_ids()))
  WITH CHECK (holding_company_id IS NULL OR holding_company_id IN (SELECT auth.user_companies()));
CREATE POLICY tenant_isolation_delete ON company_groups FOR DELETE TO app_user
  USING (id IN (SELECT public.rls_user_write_group_ids()));

-- ── company_group_members ────────────────────────────────────────────────────

ALTER TABLE company_group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_group_members FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON company_group_members;
DROP POLICY IF EXISTS tenant_isolation_select ON company_group_members;
DROP POLICY IF EXISTS tenant_isolation_insert ON company_group_members;
DROP POLICY IF EXISTS tenant_isolation_update ON company_group_members;
DROP POLICY IF EXISTS tenant_isolation_delete ON company_group_members;
CREATE POLICY tenant_isolation_select ON company_group_members FOR SELECT TO app_user
  USING (company_id IN (SELECT auth.user_companies()));
CREATE POLICY tenant_isolation_insert ON company_group_members FOR INSERT TO app_user
  WITH CHECK (company_id = app.current_company_id()
              AND company_id IN (SELECT public.rls_user_write_company_ids())
              AND (group_id IN (SELECT public.rls_user_write_group_ids()) OR public.rls_group_may_bootstrap(group_id)));
CREATE POLICY tenant_isolation_update ON company_group_members FOR UPDATE TO app_user
  USING (company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id());
CREATE POLICY tenant_isolation_delete ON company_group_members FOR DELETE TO app_user
  USING (company_id IN (SELECT auth.user_companies()));

-- ── group-keyed tables: members read, writers of a member company write ─────

ALTER TABLE group_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_accounts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON group_accounts;
DROP POLICY IF EXISTS tenant_isolation_insert ON group_accounts;
DROP POLICY IF EXISTS tenant_isolation_update ON group_accounts;
DROP POLICY IF EXISTS tenant_isolation_delete ON group_accounts;
CREATE POLICY tenant_isolation_select ON group_accounts FOR SELECT TO app_user
  USING (group_id IN (SELECT public.rls_user_group_ids()));
CREATE POLICY tenant_isolation_insert ON group_accounts FOR INSERT TO app_user
  WITH CHECK (group_id IN (SELECT public.rls_user_write_group_ids()));
CREATE POLICY tenant_isolation_update ON group_accounts FOR UPDATE TO app_user
  USING (group_id IN (SELECT public.rls_user_write_group_ids()))
  WITH CHECK (group_id IN (SELECT public.rls_user_write_group_ids()));
CREATE POLICY tenant_isolation_delete ON group_accounts FOR DELETE TO app_user
  USING (group_id IN (SELECT public.rls_user_write_group_ids()));

ALTER TABLE intercompany_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE intercompany_transactions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON intercompany_transactions;
DROP POLICY IF EXISTS tenant_isolation_insert ON intercompany_transactions;
DROP POLICY IF EXISTS tenant_isolation_update ON intercompany_transactions;
DROP POLICY IF EXISTS tenant_isolation_delete ON intercompany_transactions;
CREATE POLICY tenant_isolation_select ON intercompany_transactions FOR SELECT TO app_user
  USING (group_id IN (SELECT public.rls_user_group_ids()));
CREATE POLICY tenant_isolation_insert ON intercompany_transactions FOR INSERT TO app_user
  WITH CHECK (group_id IN (SELECT public.rls_user_write_group_ids()));
CREATE POLICY tenant_isolation_update ON intercompany_transactions FOR UPDATE TO app_user
  USING (group_id IN (SELECT public.rls_user_write_group_ids()))
  WITH CHECK (group_id IN (SELECT public.rls_user_write_group_ids()));
CREATE POLICY tenant_isolation_delete ON intercompany_transactions FOR DELETE TO app_user
  USING (group_id IN (SELECT public.rls_user_write_group_ids()));

ALTER TABLE consolidation_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE consolidation_adjustments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON consolidation_adjustments;
DROP POLICY IF EXISTS tenant_isolation_insert ON consolidation_adjustments;
DROP POLICY IF EXISTS tenant_isolation_update ON consolidation_adjustments;
DROP POLICY IF EXISTS tenant_isolation_delete ON consolidation_adjustments;
CREATE POLICY tenant_isolation_select ON consolidation_adjustments FOR SELECT TO app_user
  USING (group_id IN (SELECT public.rls_user_group_ids()));
CREATE POLICY tenant_isolation_insert ON consolidation_adjustments FOR INSERT TO app_user
  WITH CHECK (group_id IN (SELECT public.rls_user_write_group_ids()));
CREATE POLICY tenant_isolation_update ON consolidation_adjustments FOR UPDATE TO app_user
  USING (group_id IN (SELECT public.rls_user_write_group_ids()))
  WITH CHECK (group_id IN (SELECT public.rls_user_write_group_ids()));
CREATE POLICY tenant_isolation_delete ON consolidation_adjustments FOR DELETE TO app_user
  USING (group_id IN (SELECT public.rls_user_write_group_ids()));

-- group_coa_mappings keeps its company check (own companies read; the active company writes) and gains
-- the group: a mapping is written into a group the user writes.
ALTER TABLE group_coa_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_coa_mappings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON group_coa_mappings;
DROP POLICY IF EXISTS tenant_isolation_select ON group_coa_mappings;
DROP POLICY IF EXISTS tenant_isolation_insert ON group_coa_mappings;
DROP POLICY IF EXISTS tenant_isolation_update ON group_coa_mappings;
DROP POLICY IF EXISTS tenant_isolation_delete ON group_coa_mappings;
CREATE POLICY tenant_isolation_select ON group_coa_mappings FOR SELECT TO app_user
  USING (company_id IN (SELECT auth.user_companies()));
CREATE POLICY tenant_isolation_insert ON group_coa_mappings FOR INSERT TO app_user
  WITH CHECK (company_id = app.current_company_id() AND group_id IN (SELECT public.rls_user_write_group_ids()));
CREATE POLICY tenant_isolation_update ON group_coa_mappings FOR UPDATE TO app_user
  USING (company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id() AND group_id IN (SELECT public.rls_user_write_group_ids()));
CREATE POLICY tenant_isolation_delete ON group_coa_mappings FOR DELETE TO app_user
  USING (company_id IN (SELECT auth.user_companies()));

-- ── company_relationships (307, 532) ─────────────────────────────────────────

ALTER TABLE company_relationships ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_relationships FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON company_relationships;
DROP POLICY IF EXISTS tenant_isolation_insert ON company_relationships;
DROP POLICY IF EXISTS tenant_isolation_update ON company_relationships;
CREATE POLICY tenant_isolation_select ON company_relationships FOR SELECT TO app_user
  USING (parent_company_id IN (SELECT auth.user_companies()) OR child_company_id IN (SELECT auth.user_companies()));
CREATE POLICY tenant_isolation_insert ON company_relationships FOR INSERT TO app_user
  WITH CHECK (parent_company_id = app.current_company_id()
              AND parent_company_id IN (SELECT auth.user_companies())
              AND child_company_id IN (SELECT public.rls_user_write_company_ids()));
-- Either end may withdraw (deleted_at set); only someone who writes the child may leave a link live.
CREATE POLICY tenant_isolation_update ON company_relationships FOR UPDATE TO app_user
  USING (parent_company_id IN (SELECT auth.user_companies()) OR child_company_id IN (SELECT auth.user_companies()))
  WITH CHECK ((parent_company_id IN (SELECT auth.user_companies()) OR child_company_id IN (SELECT auth.user_companies()))
              AND (deleted_at IS NOT NULL OR child_company_id IN (SELECT public.rls_user_write_company_ids())));

-- ── intercompany_eliminations (307) ──────────────────────────────────────────

ALTER TABLE intercompany_eliminations ENABLE ROW LEVEL SECURITY;
ALTER TABLE intercompany_eliminations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON intercompany_eliminations;
CREATE POLICY tenant_isolation ON intercompany_eliminations FOR ALL TO app_user
  USING (group_company_id = app.current_company_id() AND group_company_id IN (SELECT auth.user_companies()))
  WITH CHECK (group_company_id = app.current_company_id() AND group_company_id IN (SELECT auth.user_companies()));

-- app_user already holds table privileges on all of these (348's defaults); the policies are the limit.
SELECT public.app_service_sync_policies();
