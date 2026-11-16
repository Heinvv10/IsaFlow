-- 999f: Budget write snapshots (MCP budget write tools, PR 1; Hein's ruling 1, 2026-11-16).
--
-- WHAT. One row per amount write an MCP budget tool makes (set_budget_amounts, set_budget_annual):
-- the version, the tool, the token's jti, the version token before and after the write, and per
-- changed cell its value before and after (`cells`, a JSON array of
-- {a: account, c1, c2, b: dimension ids or null, m: 'YYYY-MM', before, after: decimal text or null}).
-- restore_budget_version writes the before-values of the version's most recent unrestored snapshot
-- back through the grid save (every save rule applies), only while the version's token still equals
-- that snapshot's token_after, and then marks it restored.
--
-- RULES IN THE DATABASE.
--   - Tenancy: 944's forced-RLS policy, verbatim; the version by composite FK (954's form; a
--     version delete takes its snapshots with it).
--   - Column privileges: app_user INSERTs the payload columns only and UPDATEs restored_at only;
--     no DELETE. id, created_by, created_at and restored_by are never app-writable.
--   - Stamps: created_by and restored_by are the session user (auth.uid()), created_at and
--     restored_at the clock, set by the trigger whatever was sent. A restore is one-way (a restored
--     snapshot is never restored again) and changes nothing but its two stamps. With no session
--     user, a write keeps the created_by it sent (NOT NULL), and a restore is refused.
--
-- Every function here is SECURITY INVOKER: no app_definer_reviews row (930).

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS budget_write_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  version_id UUID NOT NULL,
  tool TEXT NOT NULL CHECK (tool ~ '^[a-z_]{1,64}$'),
  token_jti TEXT CHECK (token_jti IS NULL OR length(token_jti) <= 200),
  token_before TEXT NOT NULL CHECK (length(token_before) <= 40),
  token_after TEXT NOT NULL CHECK (length(token_after) <= 40),
  cells JSONB NOT NULL CHECK (jsonb_typeof(cells) = 'array' AND jsonb_array_length(cells) BETWEEN 1 AND 20000),
  -- The session's user; budget_write_snapshots_stamp overwrites anything sent.
  created_by VARCHAR(255) NOT NULL DEFAULT auth.uid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  restored_at TIMESTAMPTZ,
  restored_by VARCHAR(255),
  CONSTRAINT budget_write_snapshots_version_fk
    FOREIGN KEY (company_id, version_id) REFERENCES budget_versions (company_id, id) ON DELETE CASCADE,
  CONSTRAINT budget_write_snapshots_restored_pair CHECK ((restored_at IS NULL) = (restored_by IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_budget_write_snapshots_version
  ON budget_write_snapshots (company_id, version_id, created_at DESC);

-- Stamps on insert; on update only the one-way restore, stamped by the session user and the clock.
CREATE OR REPLACE FUNCTION public.budget_write_snapshots_stamp()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_by := COALESCE(auth.uid(), NEW.created_by);
    NEW.created_at := clock_timestamp();
    NEW.restored_at := NULL;
    NEW.restored_by := NULL;
    RETURN NEW;
  END IF;
  IF OLD.restored_at IS NOT NULL THEN
    RAISE EXCEPTION 'budget write snapshot % is already restored', OLD.id USING ERRCODE = '23514';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.version_id IS DISTINCT FROM OLD.version_id OR NEW.tool IS DISTINCT FROM OLD.tool
     OR NEW.token_jti IS DISTINCT FROM OLD.token_jti OR NEW.token_before IS DISTINCT FROM OLD.token_before
     OR NEW.token_after IS DISTINCT FROM OLD.token_after OR NEW.cells IS DISTINCT FROM OLD.cells
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a budget write snapshot changes only when it is restored' USING ERRCODE = '23514';
  END IF;
  IF NEW.restored_at IS NULL THEN
    RAISE EXCEPTION 'a budget write snapshot cannot be un-restored' USING ERRCODE = '23514';
  END IF;
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'a budget write snapshot is restored by a signed-in user' USING ERRCODE = '42501';
  END IF;
  NEW.restored_at := clock_timestamp();
  NEW.restored_by := auth.uid();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_budget_write_snapshots_stamp ON budget_write_snapshots;
CREATE TRIGGER trg_budget_write_snapshots_stamp BEFORE INSERT OR UPDATE ON budget_write_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.budget_write_snapshots_stamp();
ALTER TABLE budget_write_snapshots ENABLE ALWAYS TRIGGER trg_budget_write_snapshots_stamp;

-- ── Tenancy: 944's policy, verbatim ─────────────────────────────────────────

ALTER TABLE budget_write_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_write_snapshots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON budget_write_snapshots;
CREATE POLICY tenant_isolation ON budget_write_snapshots FOR ALL TO app_user
  USING (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()));

-- 348's default privileges gave app_user every command: take back all but SELECT, then grant per column.
REVOKE INSERT, UPDATE, DELETE ON budget_write_snapshots FROM app_user;
GRANT SELECT ON budget_write_snapshots TO app_user;
GRANT INSERT (company_id, version_id, tool, token_jti, token_before, token_after, cells) ON budget_write_snapshots TO app_user;
-- restored_at is granted only so a restore can be recorded; the trigger replaces the value written.
GRANT UPDATE (restored_at) ON budget_write_snapshots TO app_user;

REVOKE ALL ON FUNCTION public.budget_write_snapshots_stamp() FROM PUBLIC;

-- The service pool reaches the table through the mirrors 915 creates from the app_user policies.
SELECT public.app_service_sync_policies();
