-- 952: Employee bank details get a tenant, a history and one active row
-- (master plan wave 3, PR K1; Hein's decisions 5, 6 and 14). 380 made
-- payroll_bank_details with no company_id and no writer; 888 left it untracked
-- for that reason. payrollBankDetailsService.ts is now its writer, so:
--
--   1. company_id, backfilled from the employee, then a validated FK and NOT NULL.
--   2. account_holder (nullable: legacy rows and bank files may not carry one).
--   3. One active row per employee. Older duplicates are deactivated, never
--      deleted. A change is a new row: the old one stays, inactive.
--   4. RLS, enabled and forced: the active company, membership and a role. The
--      roles of withPayrollDetailAccess (owner, admin, manager) read and insert,
--      into a row that points at an employee of its own company. Only owner /
--      admin update, and only is_active (a column grant): nobody can rewrite a
--      stored number, so every change is a new row the history records. No
--      request role may DELETE or empty the table. An employee's delete still
--      removes their rows (the FK's cascade runs as the table owner, outside
--      forced RLS). A manager's INSERT stays open for a first entry; that it is
--      only a first entry is the service's rule, under the employee row lock.
--      Nothing in the app reaches the table but those two request routes, so
--      platform_admin holds nothing on it, and app_service has no mirror (915's
--      list, as impersonation_sessions): it inherits app_user's grants, so a
--      REVOKE from it would change nothing, and with no mirror those grants meet
--      app_user's policies. The service pool reads no row without forged claims.
--   5. 888's capture, ENABLE ALWAYS, as entity type payroll_bank_detail, with
--      its own arm in entity_changes_read (owner, admin, manager, as
--      payroll_employee) and its value in the entity_type CHECK. The history
--      stores the account number in full; the API masks it (SENSITIVE_FIELDS).
--      The capture function is unchanged, so 930's definer registry is too:
--      entity_change_projection already keeps every column but id and created_at.
--
-- Prefix: 950 and 951 are claimed by open PRs #1009 and #1015.
--
-- Cross-tenant by design: the backfill and the deduplication run over every
-- company, each row taking its own employee's company. No literal company_id
-- applies: the join is the scope. Nothing in the app writes this table before
-- this migration, so both are expected to touch nothing on production.
--
-- Locks: companies before entity_changes, the order a tracked write takes them,
-- so the migration does not invert a request that writes a company and is then
-- captured. entity_changes is held ACCESS EXCLUSIVE to COMMIT, with one scan
-- for the CHECK: deploy after hours. A lock not granted within 5s aborts the
-- migration, which has then changed nothing: re-run it.
--
-- Rollback: old code ignores the new columns and never writes the table, so
-- reverting code alone is safe.

SET LOCAL lock_timeout = '5s';

-- ── 1, 2. Tenant and holder ───────────────────────────────────────────────
ALTER TABLE payroll_bank_details ADD COLUMN IF NOT EXISTS company_id UUID;
ALTER TABLE payroll_bank_details ADD COLUMN IF NOT EXISTS account_holder VARCHAR(100);

UPDATE payroll_bank_details b
   SET company_id = e.company_id
  FROM payroll_employees e
 WHERE e.id = b.employee_id AND b.company_id IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint c
    WHERE c.conrelid = 'public.payroll_bank_details'::pg_catalog.regclass
      AND c.conname = 'payroll_bank_details_company_id_fkey'
  ) THEN
    ALTER TABLE payroll_bank_details
      ADD CONSTRAINT payroll_bank_details_company_id_fkey
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
ALTER TABLE payroll_bank_details VALIDATE CONSTRAINT payroll_bank_details_company_id_fkey;
ALTER TABLE payroll_bank_details ALTER COLUMN company_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payroll_bank_details_company
  ON payroll_bank_details (company_id, employee_id);

-- ── 3. One active row per employee ────────────────────────────────────────
DO $$
DECLARE v_count pg_catalog.int8;
BEGIN
  WITH ranked AS (
    SELECT b.id, pg_catalog.row_number() OVER (
             PARTITION BY b.employee_id ORDER BY b.effective_from DESC, b.created_at DESC, b.id DESC) AS rn
    FROM payroll_bank_details b WHERE b.is_active
  )
  UPDATE payroll_bank_details b SET is_active = false
    FROM ranked r WHERE r.id = b.id AND r.rn > 1;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE 'migration 952: deactivated % superseded active payroll_bank_details row(s)', v_count;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_payroll_bank_details_one_active
  ON payroll_bank_details (employee_id) WHERE is_active;

-- ── 4. RLS and grants ─────────────────────────────────────────────────────
ALTER TABLE payroll_bank_details ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_bank_details FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payroll_detail_read ON payroll_bank_details;
CREATE POLICY payroll_detail_read ON payroll_bank_details FOR SELECT TO app_user
  USING (
    company_id = app.current_company_id()
    AND company_id IN (SELECT auth.user_companies())
    AND COALESCE(public.company_member_actor_role(company_id) IN ('owner', 'admin', 'manager'), false));
DROP POLICY IF EXISTS payroll_detail_insert ON payroll_bank_details;
CREATE POLICY payroll_detail_insert ON payroll_bank_details FOR INSERT TO app_user
  WITH CHECK (
    company_id = app.current_company_id()
    AND company_id IN (SELECT auth.user_companies())
    AND COALESCE(public.company_member_actor_role(company_id) IN ('owner', 'admin', 'manager'), false)
    AND employee_id IN (SELECT e.id FROM payroll_employees e WHERE e.company_id = payroll_bank_details.company_id));
-- The WITH CHECK falls back to this USING: is_active is the only updatable column.
DROP POLICY IF EXISTS payroll_detail_update ON payroll_bank_details;
CREATE POLICY payroll_detail_update ON payroll_bank_details FOR UPDATE TO app_user
  USING (
    company_id = app.current_company_id()
    AND company_id IN (SELECT auth.user_companies())
    AND COALESCE(public.company_member_actor_role(company_id) IN ('owner', 'admin'), false));

-- A table-level REVOKE also clears column grants, so UPDATE comes back as is_active alone.
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON payroll_bank_details FROM app_user, app_service, PUBLIC;
REVOKE ALL ON payroll_bank_details FROM platform_admin;
GRANT SELECT, INSERT ON payroll_bank_details TO app_user;
GRANT UPDATE (is_active) ON payroll_bank_details TO app_user;

-- 915's function, with this table beside impersonation_sessions: no service path reads it.
CREATE OR REPLACE FUNCTION public.app_service_wanted_policies()
RETURNS TABLE (tbl regclass, cmd text)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH pol AS (
    SELECT p.polrelid, p.polcmd,
           coalesce(pg_get_expr(p.polqual, p.polrelid), 'true') = 'false' AS using_false,
           coalesce(pg_get_expr(p.polwithcheck, p.polrelid), pg_get_expr(p.polqual, p.polrelid), 'true') = 'false' AS check_false
      FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'public'
       AND c.relname NOT IN ('impersonation_sessions', 'payroll_bank_details')
       AND p.polpermissive
       AND p.polname NOT LIKE 'app\_service\_%'
       AND (p.polroles = '{0}'::oid[] OR 'app_user'::regrole = ANY (p.polroles))
  ), admitted AS (
    SELECT polrelid, 'select' AS cmd FROM pol WHERE polcmd IN ('r', '*') AND NOT using_false
    UNION SELECT polrelid, 'delete' FROM pol WHERE polcmd IN ('d', '*') AND NOT using_false
    UNION SELECT polrelid, 'insert' FROM pol WHERE polcmd IN ('a', '*') AND NOT check_false
    UNION SELECT polrelid, 'update' FROM pol WHERE polcmd IN ('w', '*') AND NOT using_false AND NOT check_false
  )
  SELECT polrelid::regclass, cmd FROM admitted
   WHERE CASE cmd WHEN 'delete' THEN has_table_privilege('app_user', polrelid, 'DELETE')
                  ELSE has_any_column_privilege('app_user', polrelid, upper(cmd)) END
$$;

-- ── 5. The history ────────────────────────────────────────────────────────
ALTER TABLE entity_changes DROP CONSTRAINT IF EXISTS entity_changes_entity_type_check;
ALTER TABLE entity_changes ADD CONSTRAINT entity_changes_entity_type_check CHECK (entity_type IN (
  'supplier', 'customer', 'gl_account', 'payroll_employee', 'company_user', 'company_invitation',
  'company_user_permission', 'company', 'approval_rule', 'approval_enforcement', 'payroll_bank_detail'));

DROP POLICY IF EXISTS entity_changes_read ON entity_changes;
CREATE POLICY entity_changes_read ON entity_changes
  FOR SELECT TO app_user
  USING (
    company_id = app.current_company_id()
    AND company_id IN (SELECT auth.user_companies())
    AND CASE
      WHEN entity_type IN ('supplier', 'customer', 'gl_account') THEN true
      WHEN entity_type = 'payroll_employee'
        THEN COALESCE(public.company_member_actor_role(company_id) IN ('owner', 'admin', 'manager'), false)
      WHEN entity_type = 'payroll_bank_detail'
        THEN COALESCE(public.company_member_actor_role(company_id) IN ('owner', 'admin', 'manager'), false)
      ELSE COALESCE(public.company_member_actor_role(company_id) IN ('owner', 'admin'), false)
    END);

-- After step 3, so the migration's own deactivations are not recorded as anyone's change.
DROP TRIGGER IF EXISTS entity_change_capture ON payroll_bank_details;
CREATE TRIGGER entity_change_capture AFTER INSERT OR UPDATE OR DELETE ON payroll_bank_details
  FOR EACH ROW EXECUTE FUNCTION public.entity_change_capture('payroll_bank_detail');
ALTER TABLE payroll_bank_details ENABLE ALWAYS TRIGGER entity_change_capture;

-- app_service's mirrors follow app_user's privileges and policies (915), bar this table's.
SELECT public.app_service_sync_policies();

-- ── Refuse to ship it any other way ───────────────────────────────────────
DO $$
DECLARE
  v_table CONSTANT pg_catalog.regclass := 'public.payroll_bank_details'::pg_catalog.regclass;
  r RECORD;
BEGIN
  -- Every grantee, not a list of the ones known today. migration_admin's seed sweep keeps its DELETE.
  FOR r IN
    SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END AS grantee, a.privilege_type
    FROM pg_catalog.pg_class c
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) a
    WHERE c.oid = v_table AND a.privilege_type IN ('DELETE', 'TRUNCATE') AND a.grantee <> c.relowner
      AND a.grantee IS DISTINCT FROM pg_catalog.to_regrole('migration_admin')::pg_catalog.oid
  LOOP
    RAISE EXCEPTION 'migration 952: % still holds % on payroll_bank_details', r.grantee, r.privilege_type;
  END LOOP;
  IF pg_catalog.has_any_column_privilege('platform_admin', v_table, 'SELECT, INSERT, UPDATE, REFERENCES')
     OR pg_catalog.has_table_privilege('platform_admin', v_table, 'DELETE, TRUNCATE, TRIGGER') THEN
    RAISE EXCEPTION 'migration 952: platform_admin still holds a privilege on payroll_bank_details';
  END IF;
  FOR r IN
    SELECT a.attname FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = v_table AND a.attnum > 0 AND NOT a.attisdropped AND a.attname <> 'is_active'
      AND pg_catalog.has_column_privilege('app_user', v_table, a.attnum, 'UPDATE')
  LOOP
    RAISE EXCEPTION 'migration 952: app_user may update %, not only is_active', r.attname;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid = v_table AND 'app_service'::pg_catalog.regrole = ANY (p.polroles)
  ) THEN
    RAISE EXCEPTION 'migration 952: app_service has a policy on payroll_bank_details';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
    WHERE c.oid = 'public.payroll_bank_details'::pg_catalog.regclass AND c.relrowsecurity AND c.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'migration 952: payroll_bank_details must have row level security enabled and forced';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger t
    WHERE t.tgrelid = 'public.payroll_bank_details'::pg_catalog.regclass AND t.tgname = 'entity_change_capture'
      AND t.tgenabled = 'A' AND t.tgfoid = 'public.entity_change_capture()'::pg_catalog.regprocedure
  ) THEN
    RAISE EXCEPTION 'migration 952: payroll_bank_details has no ENABLE ALWAYS entity_change_capture trigger';
  END IF;
END $$;
