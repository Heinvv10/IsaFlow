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
--     (a row is retired with left_date / deleted_at, never moved): triggers, so UPDATE cannot do what
--     INSERT refuses. A member row is UPDATED (ownership, method, retired with left_date, or re-activated
--     with left_date back to NULL: the only way a company that left returns, the UNIQUE (group_id,
--     company_id) refusing a second row) only by a writer of the group AND of that company, as INSERT.
--     A viewer of a member company changes nothing.
--   - app_user cannot DELETE company_groups (it cascades to members, chart, mappings and transactions;
--     the app deactivates with is_active), company_group_members (the bootstrap reads "has had a member
--     row", so the rows must outlive the session), intercompany_transactions or consolidation_adjustments
--     (the app never deletes either: adjustments are reversed, transactions kept). No policy, no DELETE.
--   - intercompany_transactions INSERT: the writer of the group, a write role in the SOURCE company, both
--     parties CURRENT members of the group, and each journal entry (if given) belongs to its own party
--     (rls_intercompany_parties_ok, which answers only for a group the caller writes). UPDATE needs the
--     group writer AND a write role in the source or the target company, and a stored row keeps its group,
--     parties, journals, amount, currency, type, date and description: matching changes only its status.
--   - group_coa_mappings: written (INSERT, UPDATE, DELETE) by a writer of the group AND of the mapped
--     company; the company account must belong to that company and the group account to that group
--     (rls_coa_mapping_ok). Read through the member company, as before.
--   - company_relationships: read by either end; created only by the parent's active company for a
--     child the user writes; withdrawn (deleted_at set) by either end; REVIVED only by someone who
--     writes the child, so a child's withdrawal cannot be undone from the parent's side; a viewer of
--     either end changes nothing. No DELETE: the row is the audit record (532).
--   - intercompany_eliminations: the parent (group_company_id) company's own rows, in 944's form; read by
--     its members, written by a write role.
--   - company_groups: UPDATE (rename, deactivate) by a group writer. A change of holding_company_id must
--     name one of the caller's companies, and created_by never changes (trigger: a WITH CHECK cannot see
--     the old row, and a check on the unchanged value would refuse a writer outside the holding company).
--   - consolidation_adjustments_on_company_periods(): the fiscal-period census counts adjustments that
--     point at a company's periods across every group, including one the company has since left.
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

-- Both parties of an intercompany transaction are CURRENT members of its group, and a journal entry named
-- on a side belongs to that side's company (the route's verifyCompanyInGroup / journalEntryBelongsToCompany).
-- It answers only for a group the caller WRITES: for any other it is false, so it is no oracle on who
-- belongs to a foreign group or whose journal is whose.
CREATE OR REPLACE FUNCTION public.rls_intercompany_parties_ok(p_group uuid, p_source uuid, p_target uuid, p_source_je uuid, p_target_je uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT p_group IN (SELECT public.rls_user_write_group_ids())
     AND EXISTS (SELECT 1 FROM public.company_group_members m WHERE m.group_id = p_group AND m.company_id = p_source AND m.left_date IS NULL)
     AND EXISTS (SELECT 1 FROM public.company_group_members m WHERE m.group_id = p_group AND m.company_id = p_target AND m.left_date IS NULL)
     AND (p_source_je IS NULL OR EXISTS (SELECT 1 FROM public.gl_journal_entries je WHERE je.id = p_source_je AND je.company_id = p_source))
     AND (p_target_je IS NULL OR EXISTS (SELECT 1 FROM public.gl_journal_entries je WHERE je.id = p_target_je AND je.company_id = p_target))
$$;

-- A mapping's two accounts belong where it says: the company account to the mapped company, the group
-- account to the group. False unless the caller writes both the group and the company (no oracle).
CREATE OR REPLACE FUNCTION public.rls_coa_mapping_ok(p_group uuid, p_group_account uuid, p_company uuid, p_company_account uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT p_group IN (SELECT public.rls_user_write_group_ids())
     AND p_company IN (SELECT public.rls_user_write_company_ids())
     AND EXISTS (SELECT 1 FROM public.group_accounts ga WHERE ga.id = p_group_account AND ga.group_id = p_group)
     AND EXISTS (SELECT 1 FROM public.gl_accounts a WHERE a.id = p_company_account AND a.company_id = p_company)
$$;

-- The fiscal-period census (gl/fiscalPeriodReferences): consolidation adjustments, of ANY group, that point at
-- one of the company's fiscal periods. The adjustment rows are the group's, so a company that has left the
-- group no longer sees them through its own session; the count is of its own periods only, and only for a
-- company a request's caller belongs to.
CREATE OR REPLACE FUNCTION public.consolidation_adjustments_on_company_periods(p_company uuid)
RETURNS integer
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  -- A request (claims present) asks only about a company it belongs to. A path with no claims (a migration, the
  -- service pool, a test on the owner's connection) is held to its own role's reach, as company_groups_guard.
  IF auth.uid() IS NOT NULL AND (p_company IS NULL OR p_company NOT IN (SELECT auth.user_companies())) THEN
    RAISE EXCEPTION 'consolidation_adjustments_on_company_periods: not a member of the company' USING ERRCODE = '42501';
  END IF;
  RETURN (SELECT COUNT(*) FROM public.consolidation_adjustments ca
           WHERE ca.fiscal_period_id IN (SELECT fp.id FROM public.fiscal_periods fp WHERE fp.company_id = p_company))::integer;
END;
$$;

ALTER FUNCTION public.rls_user_group_ids() OWNER TO migration_admin;
ALTER FUNCTION public.rls_user_write_group_ids() OWNER TO migration_admin;
ALTER FUNCTION public.rls_user_write_company_ids() OWNER TO migration_admin;
ALTER FUNCTION public.rls_group_may_bootstrap(uuid) OWNER TO migration_admin;
ALTER FUNCTION public.rls_intercompany_parties_ok(uuid, uuid, uuid, uuid, uuid) OWNER TO migration_admin;
ALTER FUNCTION public.rls_coa_mapping_ok(uuid, uuid, uuid, uuid) OWNER TO migration_admin;
ALTER FUNCTION public.consolidation_adjustments_on_company_periods(uuid) OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.rls_user_group_ids() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rls_user_write_group_ids() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rls_user_write_company_ids() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rls_group_may_bootstrap(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rls_intercompany_parties_ok(uuid, uuid, uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rls_coa_mapping_ok(uuid, uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.consolidation_adjustments_on_company_periods(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rls_user_group_ids() TO app_user;
GRANT EXECUTE ON FUNCTION public.rls_user_write_group_ids() TO app_user;
GRANT EXECUTE ON FUNCTION public.rls_user_write_company_ids() TO app_user;
GRANT EXECUTE ON FUNCTION public.rls_group_may_bootstrap(uuid) TO app_user;
GRANT EXECUTE ON FUNCTION public.rls_intercompany_parties_ok(uuid, uuid, uuid, uuid, uuid) TO app_user;
GRANT EXECUTE ON FUNCTION public.rls_coa_mapping_ok(uuid, uuid, uuid, uuid) TO app_user;
GRANT EXECUTE ON FUNCTION public.consolidation_adjustments_on_company_periods(uuid) TO app_user;

INSERT INTO public.app_definer_reviews (signature, writes, body_md5)
SELECT v.signature, 'nothing (read)', public.app_definer_hash(v.proc::regprocedure)
  FROM (VALUES
    ('rls_user_group_ids()', 'public.rls_user_group_ids()'),
    ('rls_user_write_group_ids()', 'public.rls_user_write_group_ids()'),
    ('rls_user_write_company_ids()', 'public.rls_user_write_company_ids()'),
    ('rls_group_may_bootstrap(uuid)', 'public.rls_group_may_bootstrap(uuid)'),
    ('rls_intercompany_parties_ok(uuid,uuid,uuid,uuid,uuid)', 'public.rls_intercompany_parties_ok(uuid, uuid, uuid, uuid, uuid)'),
    ('rls_coa_mapping_ok(uuid,uuid,uuid,uuid)', 'public.rls_coa_mapping_ok(uuid, uuid, uuid, uuid)'),
    ('consolidation_adjustments_on_company_periods(uuid)', 'public.consolidation_adjustments_on_company_periods(uuid)')
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

-- A stored intercompany transaction is what was recorded: matching changes only its status columns
-- (match_status, variance_amount, matched_at, matched_by).
CREATE OR REPLACE FUNCTION public.intercompany_transaction_parties_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.group_id IS DISTINCT FROM OLD.group_id
     OR NEW.source_company_id IS DISTINCT FROM OLD.source_company_id OR NEW.target_company_id IS DISTINCT FROM OLD.target_company_id
     OR NEW.source_journal_entry_id IS DISTINCT FROM OLD.source_journal_entry_id
     OR NEW.target_journal_entry_id IS DISTINCT FROM OLD.target_journal_entry_id
     OR NEW.amount IS DISTINCT FROM OLD.amount OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.transaction_type IS DISTINCT FROM OLD.transaction_type OR NEW.transaction_date IS DISTINCT FROM OLD.transaction_date
     OR NEW.description IS DISTINCT FROM OLD.description THEN
    RAISE EXCEPTION 'intercompany_transactions: a recorded transaction keeps its group, parties, journals, amount, currency, type, date and description; matching changes only its status'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_intercompany_transaction_parties_immutable ON intercompany_transactions;
CREATE TRIGGER trg_intercompany_transaction_parties_immutable BEFORE UPDATE ON intercompany_transactions
  FOR EACH ROW EXECUTE FUNCTION public.intercompany_transaction_parties_immutable();

-- company_groups: created_by never changes, and a CHANGED holding company must be one of the caller's. Only
-- when the statement carries the caller's claims: a path with none (a migration, the service pool's
-- cron) is held to its own role's reach, as everywhere else in this file.
CREATE OR REPLACE FUNCTION public.company_groups_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'company_groups: created_by never changes' USING ERRCODE = '23514';
  END IF;
  IF NEW.holding_company_id IS NOT NULL AND NEW.holding_company_id IS DISTINCT FROM OLD.holding_company_id
     AND NEW.holding_company_id NOT IN (SELECT auth.user_companies()) THEN
    RAISE EXCEPTION 'company_groups: the holding company must be one of your companies' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_company_groups_guard ON company_groups;
CREATE TRIGGER trg_company_groups_guard BEFORE UPDATE OF created_by, holding_company_id ON company_groups
  FOR EACH ROW EXECUTE FUNCTION public.company_groups_guard();

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
  WITH CHECK (id IN (SELECT public.rls_user_write_group_ids()));
-- (no DELETE policy for app_user on company_groups: see the header)

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
  USING (company_id IN (SELECT public.rls_user_write_company_ids()) AND group_id IN (SELECT public.rls_user_write_group_ids()))
  WITH CHECK (company_id = app.current_company_id() AND company_id IN (SELECT public.rls_user_write_company_ids()));
-- (no DELETE policy for app_user on company_group_members: see the header)

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
  WITH CHECK (group_id IN (SELECT public.rls_user_write_group_ids())
              AND source_company_id IN (SELECT public.rls_user_write_company_ids())
              AND public.rls_intercompany_parties_ok(group_id, source_company_id, target_company_id, source_journal_entry_id, target_journal_entry_id));
CREATE POLICY tenant_isolation_update ON intercompany_transactions FOR UPDATE TO app_user
  USING (group_id IN (SELECT public.rls_user_write_group_ids())
         AND (source_company_id IN (SELECT public.rls_user_write_company_ids()) OR target_company_id IN (SELECT public.rls_user_write_company_ids())))
  WITH CHECK (group_id IN (SELECT public.rls_user_write_group_ids())
              AND (source_company_id IN (SELECT public.rls_user_write_company_ids()) OR target_company_id IN (SELECT public.rls_user_write_company_ids())));
-- (no DELETE policy for app_user on intercompany_transactions: see the header)

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
-- (no DELETE policy for app_user on consolidation_adjustments: see the header)

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
  WITH CHECK (company_id = app.current_company_id()
              AND public.rls_coa_mapping_ok(group_id, group_account_id, company_id, company_account_id));
CREATE POLICY tenant_isolation_update ON group_coa_mappings FOR UPDATE TO app_user
  USING (company_id IN (SELECT public.rls_user_write_company_ids()) AND group_id IN (SELECT public.rls_user_write_group_ids()))
  WITH CHECK (company_id = app.current_company_id()
              AND public.rls_coa_mapping_ok(group_id, group_account_id, company_id, company_account_id));
CREATE POLICY tenant_isolation_delete ON group_coa_mappings FOR DELETE TO app_user
  USING (company_id IN (SELECT public.rls_user_write_company_ids()) AND group_id IN (SELECT public.rls_user_write_group_ids()));

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
-- Either end, with a write role in it, may withdraw (deleted_at set); only someone who writes the child may
-- leave a link live.
CREATE POLICY tenant_isolation_update ON company_relationships FOR UPDATE TO app_user
  USING (parent_company_id IN (SELECT public.rls_user_write_company_ids()) OR child_company_id IN (SELECT public.rls_user_write_company_ids()))
  WITH CHECK ((parent_company_id IN (SELECT public.rls_user_write_company_ids()) OR child_company_id IN (SELECT public.rls_user_write_company_ids()))
              AND (deleted_at IS NOT NULL OR child_company_id IN (SELECT public.rls_user_write_company_ids())));

-- ── intercompany_eliminations (307) ──────────────────────────────────────────

ALTER TABLE intercompany_eliminations ENABLE ROW LEVEL SECURITY;
ALTER TABLE intercompany_eliminations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON intercompany_eliminations;
DROP POLICY IF EXISTS tenant_isolation_select ON intercompany_eliminations;
DROP POLICY IF EXISTS tenant_isolation_insert ON intercompany_eliminations;
DROP POLICY IF EXISTS tenant_isolation_update ON intercompany_eliminations;
DROP POLICY IF EXISTS tenant_isolation_delete ON intercompany_eliminations;
CREATE POLICY tenant_isolation_select ON intercompany_eliminations FOR SELECT TO app_user
  USING (group_company_id = app.current_company_id() AND group_company_id IN (SELECT auth.user_companies()));
CREATE POLICY tenant_isolation_insert ON intercompany_eliminations FOR INSERT TO app_user
  WITH CHECK (group_company_id = app.current_company_id() AND group_company_id IN (SELECT public.rls_user_write_company_ids()));
CREATE POLICY tenant_isolation_update ON intercompany_eliminations FOR UPDATE TO app_user
  USING (group_company_id = app.current_company_id() AND group_company_id IN (SELECT public.rls_user_write_company_ids()))
  WITH CHECK (group_company_id = app.current_company_id() AND group_company_id IN (SELECT public.rls_user_write_company_ids()));
CREATE POLICY tenant_isolation_delete ON intercompany_eliminations FOR DELETE TO app_user
  USING (group_company_id = app.current_company_id() AND group_company_id IN (SELECT public.rls_user_write_company_ids()));

-- app_user already holds table privileges on all of these (348's defaults); the policies are the limit.
SELECT public.app_service_sync_policies();
