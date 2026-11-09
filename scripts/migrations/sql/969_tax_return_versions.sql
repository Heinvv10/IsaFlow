-- 969: tax_return_versions (master plan wave 5, L1a).
--
-- WHAT. One row per finalised VAT201 or EMP201 for a period: the figures as they
-- stood when somebody finalised the return, and the version chain an amendment
-- builds. A VAT201 version points at the vat_period_locks row it created (the
-- lock stays the thing that stops the period moving); an EMP201 version records
-- the pay runs it summed and their approved_plan_hash. Filing, amending and
-- superseding are L1b: this migration only creates the table and lets the app
-- insert finalised rows.
--
-- RULES IN THE DATABASE.
--   - version_no = 1 exactly when amends_version_id IS NULL.
--   - At most one non-superseded version per company, form and period.
--   - The amend stamps (amended_by, amend_reason, amended_at) are written on the
--     SUPERSEDED row at amend time; all three or none, a reason never blank, and
--     only a superseded row carries them.
--   - A VAT201 version names its lock; an EMP201 version names none.
--   - users.id is character varying: the actor columns are TEXT, never UUID.
--
-- WRITES. app_user may SELECT and INSERT named columns only: id, status and the
-- stamps take their defaults (a writable stamp gets forged; a row is born
-- 'finalised'). No UPDATE or DELETE: L1b grants the columns an amend or a
-- filing writes. History is never deleted.
--
-- A BEFORE INSERT trigger (SECURITY INVOKER) refuses an amends_version_id,
-- vat_period_lock_id or sars_submission_id that is not this company's (and, for
-- a version it amends, not this form and period): the plain foreign keys alone
-- would accept another tenant's id. The lock must be the active lock of the same period. A second
-- trigger refuses every DELETE and any change to what was recorded.
--
-- Rollback: DROP TABLE tax_return_versions; DROP FUNCTION public.tax_return_versions_same_company(); DROP FUNCTION public.tax_return_versions_immutable(); DROP FUNCTION public.tax_return_versions_no_truncate() (nothing references them).

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE TABLE IF NOT EXISTS tax_return_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  form_type TEXT NOT NULL CHECK (form_type IN ('VAT201', 'EMP201')),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  version_no INTEGER NOT NULL CHECK (version_no >= 1),
  status TEXT NOT NULL DEFAULT 'finalised' CHECK (status IN ('finalised', 'filed', 'superseded')),
  -- VAT201: output, input, net (from the lock row) and sarsFields (the report boxes).
  -- EMP201: generateEMP201's figures plus runs [{id, approvedPlanHash}].
  figures JSONB NOT NULL,
  -- VAT201: the lock's posted_through. EMP201: the latest approved_at among the runs.
  posted_through TIMESTAMPTZ NOT NULL,
  vat_period_lock_id UUID REFERENCES vat_period_locks(id),
  sars_submission_id UUID REFERENCES sars_submissions(id),
  filed_reference TEXT,
  amends_version_id UUID REFERENCES tax_return_versions(id),
  finalised_by TEXT NOT NULL,
  finalised_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  filed_by TEXT,
  filed_at TIMESTAMPTZ,
  amended_by TEXT,
  amend_reason TEXT,
  amended_at TIMESTAMPTZ,
  CONSTRAINT tax_return_versions_period_ck CHECK (period_end >= period_start),
  CONSTRAINT tax_return_versions_chain_ck CHECK ((version_no = 1) = (amends_version_id IS NULL)),
  CONSTRAINT tax_return_versions_lock_ck CHECK ((form_type = 'VAT201') = (vat_period_lock_id IS NOT NULL)),
  CONSTRAINT tax_return_versions_amend_ck CHECK (
    (amended_at IS NULL AND amended_by IS NULL AND amend_reason IS NULL)
    OR (status = 'superseded' AND amended_at IS NOT NULL AND amended_by IS NOT NULL
        AND amend_reason IS NOT NULL AND btrim(amend_reason) <> '')
  ),
  CONSTRAINT tax_return_versions_filed_ck CHECK (
    ((filed_at IS NULL AND filed_by IS NULL) OR (filed_at IS NOT NULL AND filed_by IS NOT NULL))
    AND (status <> 'filed' OR (filed_at IS NOT NULL AND filed_by IS NOT NULL))
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tax_return_versions_version
  ON tax_return_versions (company_id, form_type, period_start, period_end, version_no);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tax_return_versions_one_current
  ON tax_return_versions (company_id, form_type, period_start, period_end)
  WHERE status <> 'superseded';

CREATE INDEX IF NOT EXISTS idx_tax_return_versions_lock
  ON tax_return_versions (vat_period_lock_id) WHERE vat_period_lock_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.tax_return_versions_same_company()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.amends_version_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM tax_return_versions v
        WHERE v.id = NEW.amends_version_id AND v.company_id = NEW.company_id
          AND v.form_type = NEW.form_type AND v.period_start = NEW.period_start AND v.period_end = NEW.period_end) THEN
    RAISE EXCEPTION 'amends_version_id % is not a version of this company''s same return', NEW.amends_version_id
      USING ERRCODE = '23514';
  END IF;
  IF NEW.vat_period_lock_id IS NOT NULL THEN
    -- FOR SHARE: an unlock racing this insert waits for it, so the lock cannot be released between check and insert.
    PERFORM 1 FROM vat_period_locks l
      WHERE l.id = NEW.vat_period_lock_id AND l.company_id = NEW.company_id
        AND l.period_start = NEW.period_start AND l.period_end = NEW.period_end AND l.unlocked_at IS NULL
      FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'vat_period_lock_id % is not this company''s active lock for this period', NEW.vat_period_lock_id
        USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.sars_submission_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM sars_submissions s WHERE s.id = NEW.sars_submission_id AND s.company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'sars_submission_id % is not this company''s submission', NEW.sars_submission_id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_tax_return_versions_same_company ON tax_return_versions;
CREATE TRIGGER trg_tax_return_versions_same_company BEFORE INSERT ON tax_return_versions
  FOR EACH ROW EXECUTE FUNCTION public.tax_return_versions_same_company();
ALTER TABLE tax_return_versions ENABLE ALWAYS TRIGGER trg_tax_return_versions_same_company;

-- A finalised return is history: no DELETE ever, and no UPDATE of what was recorded (the figures, the period, the
-- chain, the lock, who finalised). Only status, filed_*, amended_* and sars_submission_id may change, and L1b is
-- the one to grant and widen that. ENABLE ALWAYS, so it also binds BYPASSRLS roles and replication; the table's owner
-- (and a superuser) can still switch a trigger off, which is why the privileges below are revoked too.
CREATE OR REPLACE FUNCTION public.tax_return_versions_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'tax_return_versions rows are history and are never deleted' USING ERRCODE = '23514';
  END IF;
  IF (NEW.id, NEW.company_id, NEW.form_type, NEW.period_start, NEW.period_end, NEW.version_no, NEW.figures, NEW.posted_through,
      NEW.vat_period_lock_id, NEW.amends_version_id, NEW.finalised_by, NEW.finalised_at)
     IS DISTINCT FROM
     (OLD.id, OLD.company_id, OLD.form_type, OLD.period_start, OLD.period_end, OLD.version_no, OLD.figures, OLD.posted_through,
      OLD.vat_period_lock_id, OLD.amends_version_id, OLD.finalised_by, OLD.finalised_at) THEN
    RAISE EXCEPTION 'a finalised return''s recorded figures, period, chain and lock are never changed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_tax_return_versions_immutable ON tax_return_versions;
CREATE TRIGGER trg_tax_return_versions_immutable BEFORE UPDATE OR DELETE ON tax_return_versions
  FOR EACH ROW EXECUTE FUNCTION public.tax_return_versions_immutable();
ALTER TABLE tax_return_versions ENABLE ALWAYS TRIGGER trg_tax_return_versions_immutable;

-- Emptying the table in one statement skips row triggers and RLS, and migration_admin and the owner keep that
-- privilege: a statement-level trigger refuses it.
CREATE OR REPLACE FUNCTION public.tax_return_versions_no_truncate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'tax_return_versions rows are history and are never truncated' USING ERRCODE = '23514';
END;
$$;
DROP TRIGGER IF EXISTS trg_tax_return_versions_no_truncate ON tax_return_versions;
CREATE TRIGGER trg_tax_return_versions_no_truncate BEFORE TRUNCATE ON tax_return_versions
  FOR EACH STATEMENT EXECUTE FUNCTION public.tax_return_versions_no_truncate();
ALTER TABLE tax_return_versions ENABLE ALWAYS TRIGGER trg_tax_return_versions_no_truncate;

ALTER TABLE tax_return_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_return_versions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON tax_return_versions;
CREATE POLICY tenant_isolation ON tax_return_versions FOR ALL TO app_user
  USING (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()));

-- Migration 352's default privileges leave platform_admin (BYPASSRLS) with UPDATE and DELETE, and 348 gives
-- migration_admin ALL: clear the writers, then give back only what each needs (952 does the same). A table-level
-- REVOKE also clears column grants. The owner and migration_admin keep theirs (the triggers above refuse their writes).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON tax_return_versions
  FROM app_user, app_service, platform_admin, PUBLIC;
-- Whoever else holds them, seen or not (production's ACL is not read here): every grantee but the owner and
-- migration_admin loses UPDATE, DELETE and TRUNCATE, as 952 does.
DO $$
DECLARE
  v_grantee pg_catalog.text;
BEGIN
  FOR v_grantee IN
    SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(a.grantee)) END
    FROM pg_catalog.pg_class c
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) a
    WHERE c.oid = 'public.tax_return_versions'::pg_catalog.regclass
      AND a.privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE') AND a.grantee <> c.relowner
      AND a.grantee IS DISTINCT FROM pg_catalog.to_regrole('migration_admin')::pg_catalog.oid
  LOOP
    EXECUTE pg_catalog.format('REVOKE UPDATE, DELETE, TRUNCATE ON public.tax_return_versions FROM %s CASCADE', v_grantee);
  END LOOP;
  -- Postcondition: nobody but the owner and migration_admin may still hold a writer privilege.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) a
    WHERE c.oid = 'public.tax_return_versions'::pg_catalog.regclass
      AND a.privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE') AND a.grantee <> c.relowner
      AND a.grantee IS DISTINCT FROM pg_catalog.to_regrole('migration_admin')::pg_catalog.oid
  ) THEN
    RAISE EXCEPTION 'migration 969: tax_return_versions still grants UPDATE, DELETE or TRUNCATE to a role other than its owner and migration_admin';
  END IF;
END $$;
GRANT SELECT ON tax_return_versions TO app_user, platform_admin;
GRANT INSERT (company_id, form_type, period_start, period_end, version_no, figures, posted_through,
  vat_period_lock_id, amends_version_id, finalised_by) ON tax_return_versions TO app_user;
