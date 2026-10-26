-- 947: Budget versions and dimension keys (budgets programme P1;
-- docs/plans/budgets/P1-schema-versions-spec.md, shared contract
-- docs/plans/budgets/00-shared-contract.md, decisions 1-4 and 11-14).
--
-- WHY. A company had one budget per account and month (944). Budgets now have
-- VERSIONS (original | reforecast | scenario; draft -> approved -> locked) and
-- every amount may carry a cost centre (CC1, CC2) or business unit. Two rules
-- hold in the database, against app_user and the app_service login alike:
--   - a LOCKED version's amounts cannot be inserted, changed or deleted
--     (budget_month_amounts_refuse_locked, ENABLE ALWAYS, FOR SHARE on the
--     version so a lock and a write serialise);
--   - one GRAIN per account per version (decision 4): company level (no
--     dimension) or one dimension set, never both, by the exclusion constraint
--     budget_month_amounts_one_grain, so a roll-up never double counts.
-- Status moves are guarded (budget_versions_guard) and each one writes its own
-- audit_log row (budget_versions_audit). The owner-only unlock is an app rule
-- (decision 11): the database guarantees that locked amounts do not change
-- while locked, and that leaving locked needs a reason and leaves an audit
-- row the app pools cannot delete. Every function here is SECURITY INVOKER and
-- branches on row data only, never on current_user, claims or settings.
-- Company consistency of version, CC1, CC2, BU and based-on is by composite
-- foreign key (RI runs as the owner, cannot be steered by RLS); the CC kind
-- (cc_type) by trigger, failing closed when the centre is not visible.
-- The CC and BU keys are NO ACTION (checked at the end of the statement), not
-- RESTRICT, so a company delete that cascades to both the amounts and the
-- masters is not refused half-way; a direct master delete still is.
--
-- CONVERSION. Every existing month row is assigned to an "Original" version of
-- the registry year holding its month (public.fiscal_year_for_date), created
-- approved and primary (decision 3), in place: version_id is SET, nothing is
-- inserted or deleted. A month the registry cannot place stops the migration
-- naming the company and month (no calendar fallback). Before and after, the
-- count and sum per company and per company+account are compared, the "after"
-- side read ONLY through the primary read path (primary version whose year is
-- the registry year of the month); any difference raises
-- '947 verification failed'. SET NOT NULL is a second check. The conversion
-- UPDATE bumps updated_at of every converted row to the deploy time
-- (accounting_updated_at); created_at is untouched.
-- 944's one-shot budget_months_from_legacy is redefined with only its INSERT
-- changed (version and the new unique key), so the 944 suites still run.
--
-- LOCKS. budget_month_amounts: ACCESS EXCLUSIVE (generated column rewrite,
-- constraints; the table is one row per company, account and month).
-- cost_centres, business_units: SHARE for the (company_id, id) unique indexes,
-- SHARE ROW EXCLUSIVE for the FK adds: writes to the masters wait for
-- milliseconds; journal-line FK checks (ROW SHARE) do not. lock_timeout 5s:
-- on a trip the file rolls back whole; rerun it (it is idempotent: IF NOT
-- EXISTS, pg_constraint guards, conversion of version_id IS NULL rows only).
--
-- ROLLBACK. scripts/rollback-deploy.sh reverts code, never this migration.
-- Pre-P1 code on this schema:
--   reads (budgets page, BvA, export, comparator, MCP, packs): identical
--     numbers while only converted primaries at company grain exist;
--   upsertBudget / copyBudgets: fail loudly (42P10 at plan time: their
--     ON CONFLICT (company_id, gl_account_id, month) has no matching
--     constraint), nothing written; budget saves return 500 until roll-forward;
--   deleteBudget: works, deleting the account's months of the year in EVERY
--     version (refused, BV001, when one is locked).
-- Runbook: before rolling code back run
--   SELECT count(*) FROM budget_versions WHERE NOT is_primary;
--   SELECT count(*) FROM budget_month_amounts WHERE dim_grain <> 0;
-- If both are 0, old reads are exact. Otherwise old reads over-count: roll
-- forward instead. Manual schema rollback (Hein-approved only, valid only
-- while both counts are 0): re-add UNIQUE (company_id, gl_account_id, month);
-- drop one_grain, one_per_cell, one_dimension, the FKs, the triggers (also
-- trg_cost_centres_keep_budget_kind on cost_centres) and the view; drop the
-- columns and budget_versions; restore 944's budget_months_from_legacy body.
-- No default-filling trigger for version_id is added on purpose: it would hide
-- a writer that forgot the version by landing its rows in the primary.
-- A locked version refuses DELETE, so it also blocks a company cascade delete
-- (QA purge scripts unlock first).
--
-- ERROR CODES (a contract with P2): BV001 locked; BV002 illegal transition or
-- immutable field; 23514 unlock without a reason, a centre of the wrong
-- cc_type, a used centre's cc_type change, or two dimensions on one amount
-- (budget_month_amounts_one_dimension, decision 14); 23P01 with constraint
-- budget_month_amounts_one_grain.

SET LOCAL lock_timeout = '5s';

-- ── budget_versions ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS budget_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  -- The registry LABEL (gl/fiscalYearRegistry), as accounting_budgets.fiscal_year.
  fiscal_year INTEGER NOT NULL,
  name TEXT NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 120),
  kind TEXT NOT NULL CHECK (kind IN ('original', 'reforecast', 'scenario')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'locked')),
  based_on_version_id UUID NULL,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  approved_by VARCHAR(255),
  approved_at TIMESTAMPTZ,
  locked_by VARCHAR(255),
  locked_at TIMESTAMPTZ,
  -- The latest unlock; the history is in audit_log.
  unlocked_by VARCHAR(255),
  unlocked_at TIMESTAMPTZ,
  unlock_reason TEXT,
  created_by VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT budget_versions_company_id_id UNIQUE (company_id, id),
  CONSTRAINT budget_versions_name_per_year UNIQUE (company_id, fiscal_year, name),
  -- Column-list SET NULL (PG15+): a plain SET NULL would null company_id too.
  CONSTRAINT budget_versions_based_on_same_company
    FOREIGN KEY (company_id, based_on_version_id) REFERENCES budget_versions (company_id, id)
    ON DELETE SET NULL (based_on_version_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_budget_versions_one_primary
  ON budget_versions (company_id, fiscal_year) WHERE is_primary;
CREATE UNIQUE INDEX IF NOT EXISTS uq_budget_versions_one_original
  ON budget_versions (company_id, fiscal_year) WHERE kind = 'original';

ALTER TABLE budget_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_versions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON budget_versions;
-- 944's (897's) predicate, verbatim: the active company AND membership.
CREATE POLICY tenant_isolation ON budget_versions FOR ALL TO app_user
  USING (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()));
-- UPDATE is also what the amounts trigger's FOR SHARE needs (a row lock needs UPDATE).
-- INSERT is per column: an app session creates drafts only (status and the approval, lock and
-- unlock stamps take their defaults), so it cannot insert an approved version, which would
-- carry no audit row (the audit trigger is on the status UPDATE). Only the migration's
-- conversion, as the owner, inserts approved versions.
GRANT SELECT, UPDATE, DELETE ON budget_versions TO app_user;
REVOKE INSERT ON budget_versions FROM app_user;
GRANT INSERT (id, company_id, fiscal_year, name, kind, based_on_version_id, is_primary, created_by)
  ON budget_versions TO app_user;

DROP TRIGGER IF EXISTS trg_budget_versions_updated_at ON budget_versions;
CREATE TRIGGER trg_budget_versions_updated_at BEFORE UPDATE ON budget_versions
  FOR EACH ROW EXECUTE FUNCTION accounting_updated_at();

-- Status moves and immutable fields. Legal moves: draft -> approved (approver
-- stamped), approved -> locked (locker stamped), locked -> approved (unlocker
-- stamped and a reason). Each stamp changes only in its own move. While locked
-- only is_primary (and updated_at) may change. A locked version is not deleted.
CREATE OR REPLACE FUNCTION public.budget_versions_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'locked' THEN
      RAISE EXCEPTION 'budget version % is locked and cannot be deleted', OLD.id USING ERRCODE = 'BV001';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'locked' THEN
      RAISE EXCEPTION 'a budget version cannot be created locked' USING ERRCODE = 'BV002';
    END IF;
    IF NEW.status = 'approved' AND (NEW.approved_by IS NULL OR NEW.approved_at IS NULL) THEN
      RAISE EXCEPTION 'an approved budget version needs approved_by and approved_at' USING ERRCODE = 'BV002';
    END IF;
    IF NEW.status = 'draft' AND (NEW.approved_by IS NOT NULL OR NEW.approved_at IS NOT NULL) THEN
      RAISE EXCEPTION 'a draft budget version cannot carry an approval' USING ERRCODE = 'BV002';
    END IF;
    IF NEW.locked_by IS NOT NULL OR NEW.locked_at IS NOT NULL
       OR NEW.unlocked_by IS NOT NULL OR NEW.unlocked_at IS NOT NULL OR NEW.unlock_reason IS NOT NULL THEN
      RAISE EXCEPTION 'a new budget version cannot carry lock or unlock stamps' USING ERRCODE = 'BV002';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF (NEW.id, NEW.company_id, NEW.fiscal_year, NEW.kind, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.company_id, OLD.fiscal_year, OLD.kind, OLD.created_by, OLD.created_at)
     OR NEW.based_on_version_id IS DISTINCT FROM OLD.based_on_version_id THEN
    -- based_on may only be cleared by its own FK (ON DELETE SET NULL of the source).
    IF NOT (NEW.based_on_version_id IS NULL AND OLD.based_on_version_id IS NOT NULL
            AND (NEW.id, NEW.company_id, NEW.fiscal_year, NEW.kind, NEW.created_by, NEW.created_at)
                IS NOT DISTINCT FROM (OLD.id, OLD.company_id, OLD.fiscal_year, OLD.kind, OLD.created_by, OLD.created_at)
            AND NOT EXISTS (SELECT 1 FROM budget_versions s
                             WHERE s.id = OLD.based_on_version_id AND s.company_id = OLD.company_id)) THEN
      RAISE EXCEPTION 'budget version % : id, company, fiscal year, kind, based-on and creator cannot change', OLD.id
        USING ERRCODE = 'BV002';
    END IF;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status = 'draft' AND NEW.status = 'approved' THEN
      IF NEW.approved_by IS NULL OR NEW.approved_at IS NULL THEN
        RAISE EXCEPTION 'approving budget version % needs approved_by and approved_at', OLD.id USING ERRCODE = 'BV002';
      END IF;
    ELSIF OLD.status = 'approved' AND NEW.status = 'locked' THEN
      -- A fresh stamp for every lock: a second lock cannot reuse the previous one's actor and time.
      IF NEW.locked_by IS NULL OR NEW.locked_at IS NULL OR NEW.locked_at IS NOT DISTINCT FROM OLD.locked_at
         OR NEW.locked_at < COALESCE(OLD.unlocked_at, OLD.approved_at) THEN
        RAISE EXCEPTION 'locking budget version % needs a new locked_by and locked_at', OLD.id USING ERRCODE = 'BV002';
      END IF;
    ELSIF OLD.status = 'locked' AND NEW.status = 'approved' THEN
      -- A fresh stamp and reason for every unlock, never the previous unlock's.
      IF NEW.unlocked_by IS NULL OR NEW.unlocked_at IS NULL OR NEW.unlocked_at IS NOT DISTINCT FROM OLD.unlocked_at
         OR NEW.unlocked_at < OLD.locked_at THEN
        RAISE EXCEPTION 'unlocking budget version % needs a new unlocked_by and unlocked_at', OLD.id USING ERRCODE = 'BV002';
      END IF;
      -- Any non-whitespace character (btrim strips only spaces; a tab or newline is no reason).
      IF NEW.unlock_reason IS NULL OR NEW.unlock_reason !~ '\S' THEN
        RAISE EXCEPTION 'unlocking budget version % needs a reason', OLD.id USING ERRCODE = '23514';
      END IF;
    ELSE
      RAISE EXCEPTION 'budget version % cannot move from % to %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'BV002';
    END IF;
  END IF;

  -- Each stamp changes only in its own move.
  IF (NEW.approved_by, NEW.approved_at) IS DISTINCT FROM (OLD.approved_by, OLD.approved_at)
     AND NOT (OLD.status = 'draft' AND NEW.status = 'approved') THEN
    RAISE EXCEPTION 'budget version % : the approval changes only when it is approved', OLD.id USING ERRCODE = 'BV002';
  END IF;
  IF (NEW.locked_by, NEW.locked_at) IS DISTINCT FROM (OLD.locked_by, OLD.locked_at)
     AND NOT (OLD.status = 'approved' AND NEW.status = 'locked') THEN
    RAISE EXCEPTION 'budget version % : the lock stamp changes only when it is locked', OLD.id USING ERRCODE = 'BV002';
  END IF;
  IF (NEW.unlocked_by, NEW.unlocked_at, NEW.unlock_reason) IS DISTINCT FROM (OLD.unlocked_by, OLD.unlocked_at, OLD.unlock_reason)
     AND NOT (OLD.status = 'locked' AND NEW.status = 'approved') THEN
    RAISE EXCEPTION 'budget version % : the unlock stamp changes only when it is unlocked', OLD.id USING ERRCODE = 'BV002';
  END IF;

  -- While locked (and staying locked), only is_primary and updated_at may change.
  IF OLD.status = 'locked' AND NEW.status = 'locked' AND NEW.name IS DISTINCT FROM OLD.name THEN
    RAISE EXCEPTION 'budget version % is locked' , OLD.id USING ERRCODE = 'BV001';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_budget_versions_guard ON budget_versions;
CREATE TRIGGER trg_budget_versions_guard BEFORE INSERT OR UPDATE OR DELETE ON budget_versions
  FOR EACH ROW EXECUTE FUNCTION public.budget_versions_guard();
ALTER TABLE budget_versions ENABLE ALWAYS TRIGGER trg_budget_versions_guard;

-- One audit_log row per status move, written by the database so no path can
-- move a version without one. The actor is the stamp the move set (column
-- data, never a setting). audit_log's action CHECK has no lock or unlock, so
-- those are 'update' with metadata.transition saying which.
CREATE OR REPLACE FUNCTION public.budget_versions_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  transition text; actor text;
BEGIN
  IF NEW.status = 'approved' AND OLD.status = 'draft' THEN
    transition := 'approve'; actor := NEW.approved_by;
  ELSIF NEW.status = 'locked' THEN
    transition := 'lock'; actor := NEW.locked_by;
  ELSE
    transition := 'unlock'; actor := NEW.unlocked_by;
  END IF;
  INSERT INTO audit_log (company_id, user_id, action, entity_type, entity_id, entity_ref, changes)
  VALUES (
    NEW.company_id, actor, CASE WHEN transition = 'approve' THEN 'approve' ELSE 'update' END,
    'budget', NEW.id, left('FY' || NEW.fiscal_year || ' ' || NEW.name, 100),
    jsonb_build_object(
      'fields', jsonb_build_array(jsonb_build_object('field', 'status', 'old', OLD.status, 'new', NEW.status, 'label', 'Status')),
      'metadata', jsonb_strip_nulls(jsonb_build_object(
        'transition', transition,
        'reason', CASE WHEN transition = 'unlock' THEN NEW.unlock_reason END,
        'fiscalYear', NEW.fiscal_year,
        'versionName', NEW.name))));
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_budget_versions_audit ON budget_versions;
CREATE TRIGGER trg_budget_versions_audit AFTER UPDATE OF status ON budget_versions
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION public.budget_versions_audit();
ALTER TABLE budget_versions ENABLE ALWAYS TRIGGER trg_budget_versions_audit;

-- ── budget_month_amounts: version and dimension keys ────────────────────────

ALTER TABLE budget_month_amounts
  ADD COLUMN IF NOT EXISTS version_id UUID,   -- NOT NULL after the conversion below
  ADD COLUMN IF NOT EXISTS cc1_id UUID,
  ADD COLUMN IF NOT EXISTS cc2_id UUID,
  ADD COLUMN IF NOT EXISTS bu_id UUID;
-- The set of dimension kinds an amount uses (0 = company level): the grain.
ALTER TABLE budget_month_amounts
  ADD COLUMN IF NOT EXISTS dim_grain SMALLINT GENERATED ALWAYS AS (
    ((CASE WHEN cc1_id IS NOT NULL THEN 1 ELSE 0 END)
   + (CASE WHEN cc2_id IS NOT NULL THEN 2 ELSE 0 END)
   + (CASE WHEN bu_id IS NOT NULL THEN 4 ELSE 0 END))::smallint) STORED;

-- Decision 14: an amount carries at most ONE dimension (no CC1 + BU grain).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'budget_month_amounts_one_dimension'
                    AND conrelid = 'public.budget_month_amounts'::regclass) THEN
    ALTER TABLE budget_month_amounts ADD CONSTRAINT budget_month_amounts_one_dimension
      CHECK (num_nonnulls(cc1_id, cc2_id, bu_id) <= 1);
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_cost_centres_company_id ON cost_centres (company_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_business_units_company_id ON business_units (company_id, id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'budget_month_amounts_version_fk'
                    AND conrelid = 'public.budget_month_amounts'::regclass) THEN
    ALTER TABLE budget_month_amounts ADD CONSTRAINT budget_month_amounts_version_fk
      FOREIGN KEY (company_id, version_id) REFERENCES budget_versions (company_id, id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'budget_month_amounts_cc1_fk'
                    AND conrelid = 'public.budget_month_amounts'::regclass) THEN
    ALTER TABLE budget_month_amounts ADD CONSTRAINT budget_month_amounts_cc1_fk
      FOREIGN KEY (company_id, cc1_id) REFERENCES cost_centres (company_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'budget_month_amounts_cc2_fk'
                    AND conrelid = 'public.budget_month_amounts'::regclass) THEN
    ALTER TABLE budget_month_amounts ADD CONSTRAINT budget_month_amounts_cc2_fk
      FOREIGN KEY (company_id, cc2_id) REFERENCES cost_centres (company_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'budget_month_amounts_bu_fk'
                    AND conrelid = 'public.budget_month_amounts'::regclass) THEN
    ALTER TABLE budget_month_amounts ADD CONSTRAINT budget_month_amounts_bu_fk
      FOREIGN KEY (company_id, bu_id) REFERENCES business_units (company_id, id);
  END IF;
END;
$$;
-- The masters' delete checks look amounts up by these.
CREATE INDEX IF NOT EXISTS idx_bma_cc1 ON budget_month_amounts (cc1_id) WHERE cc1_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bma_cc2 ON budget_month_amounts (cc2_id) WHERE cc2_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bma_bu ON budget_month_amounts (bu_id) WHERE bu_id IS NOT NULL;

-- CC1 and CC2 are both cost_centres rows; the kind must match the column, as
-- journal lines require (gl/journalCostCentreValidation). The composite FK has
-- the last word on company (it also holds a centre against a later re-home);
-- this trigger refuses a centre that is not the company's, or that this
-- session cannot see, with 23503 (fails closed, never passed), and a centre
-- of the other kind with 23514.
CREATE OR REPLACE FUNCTION public.budget_month_amounts_dimension_kinds()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  t text;
BEGIN
  IF NEW.cc1_id IS NOT NULL THEN
    SELECT cc.cc_type INTO t FROM cost_centres cc WHERE cc.id = NEW.cc1_id AND cc.company_id = NEW.company_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'budget cc1_id % is not a cost centre of company %', NEW.cc1_id, NEW.company_id USING ERRCODE = '23503';
    END IF;
    IF t IS DISTINCT FROM 'cc1' THEN
      RAISE EXCEPTION 'budget cc1_id % is not a CC1 cost centre of company %', NEW.cc1_id, NEW.company_id USING ERRCODE = '23514';
    END IF;
  END IF;
  t := NULL;
  IF NEW.cc2_id IS NOT NULL THEN
    SELECT cc.cc_type INTO t FROM cost_centres cc WHERE cc.id = NEW.cc2_id AND cc.company_id = NEW.company_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'budget cc2_id % is not a cost centre of company %', NEW.cc2_id, NEW.company_id USING ERRCODE = '23503';
    END IF;
    IF t IS DISTINCT FROM 'cc2' THEN
      RAISE EXCEPTION 'budget cc2_id % is not a CC2 cost centre of company %', NEW.cc2_id, NEW.company_id USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_budget_month_amounts_dimension_kinds ON budget_month_amounts;
CREATE TRIGGER trg_budget_month_amounts_dimension_kinds
  BEFORE INSERT OR UPDATE OF company_id, cc1_id, cc2_id ON budget_month_amounts
  FOR EACH ROW EXECUTE FUNCTION public.budget_month_amounts_dimension_kinds();
ALTER TABLE budget_month_amounts ENABLE ALWAYS TRIGGER trg_budget_month_amounts_dimension_kinds;

-- The kind holds after the write too: a centre a budget amount uses cannot change cc_type
-- (journal lines carry the same reference and are not covered here).
CREATE OR REPLACE FUNCTION public.cost_centres_keep_budget_kind()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM budget_month_amounts bm
              WHERE bm.company_id = OLD.company_id AND (bm.cc1_id = OLD.id OR bm.cc2_id = OLD.id)) THEN
    RAISE EXCEPTION 'cost centre % is used by budget amounts; its kind (cc_type) cannot change', OLD.id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_cost_centres_keep_budget_kind ON cost_centres;
CREATE TRIGGER trg_cost_centres_keep_budget_kind BEFORE UPDATE OF cc_type ON cost_centres
  FOR EACH ROW WHEN (OLD.cc_type IS DISTINCT FROM NEW.cc_type) EXECUTE FUNCTION public.cost_centres_keep_budget_kind();
ALTER TABLE cost_centres ENABLE ALWAYS TRIGGER trg_cost_centres_keep_budget_kind;

-- A locked version's amounts are immutable. FOR SHARE on the version conflicts
-- with the FOR NO KEY UPDATE a status UPDATE takes, so a write and a lock
-- serialise: a writer in flight holds the locker back until it commits, and a
-- lock in flight makes the writer re-read the version, see 'locked' and fail.
-- (The FK's own FOR KEY SHARE does not: a status change is not a key change.)
-- A version the session cannot see is never taken as unlocked (23503).
-- On DELETE a version already gone is the FK cascade of a version delete, which
-- budget_versions_guard only lets through for a version that is not locked.
-- A NULL version_id exists only while this migration converts (and is then
-- refused by NOT NULL): it has no version to check.
CREATE OR REPLACE FUNCTION public.budget_month_amounts_refuse_locked()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  s text;
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.version_id IS NOT NULL THEN
    SELECT v.status INTO s FROM budget_versions v
     WHERE v.id = NEW.version_id AND v.company_id = NEW.company_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'budget version % not found for company %', NEW.version_id, NEW.company_id USING ERRCODE = '23503';
    END IF;
    IF s = 'locked' THEN
      RAISE EXCEPTION 'budget version % is locked', NEW.version_id USING ERRCODE = 'BV001';
    END IF;
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.version_id IS NOT NULL THEN
    s := NULL;
    SELECT v.status INTO s FROM budget_versions v
     WHERE v.id = OLD.version_id AND v.company_id = OLD.company_id FOR SHARE;
    IF FOUND AND s = 'locked' THEN
      RAISE EXCEPTION 'budget version % is locked', OLD.version_id USING ERRCODE = 'BV001';
    END IF;
    IF NOT FOUND AND TG_OP = 'UPDATE' THEN
      RAISE EXCEPTION 'budget version % not found for company %', OLD.version_id, OLD.company_id USING ERRCODE = '23503';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_budget_month_amounts_refuse_locked ON budget_month_amounts;
CREATE TRIGGER trg_budget_month_amounts_refuse_locked
  BEFORE INSERT OR UPDATE OR DELETE ON budget_month_amounts
  FOR EACH ROW EXECUTE FUNCTION public.budget_month_amounts_refuse_locked();
ALTER TABLE budget_month_amounts ENABLE ALWAYS TRIGGER trg_budget_month_amounts_refuse_locked;

-- ── Conversion ───────────────────────────────────────────────────────────────

-- The year's primary version; when the year has none, an approved primary
-- 'Original' stamped by p_actor. A year whose primary is not an original
-- returns that primary (never the case during this conversion).
CREATE OR REPLACE FUNCTION public.budget_version_original(p_company uuid, p_fiscal_year int, p_actor text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v uuid;
BEGIN
  SELECT id INTO v FROM budget_versions
   WHERE company_id = p_company AND fiscal_year = p_fiscal_year AND is_primary;
  IF v IS NOT NULL THEN RETURN v; END IF;
  INSERT INTO budget_versions (company_id, fiscal_year, name, kind, status, is_primary, approved_by, approved_at, created_by)
  VALUES (p_company, p_fiscal_year, 'Original', 'original', 'approved', true, p_actor, now(), p_actor)
  ON CONFLICT (company_id, fiscal_year) WHERE is_primary DO NOTHING;
  SELECT id INTO v FROM budget_versions
   WHERE company_id = p_company AND fiscal_year = p_fiscal_year AND is_primary;
  RETURN v;
END;
$$;

-- The registry label of a month; a month the registry cannot place stops the
-- caller, naming the company and month (no calendar fallback).
CREATE OR REPLACE FUNCTION public.budget_month_registry_label(p_company uuid, p_month date)
RETURNS int
LANGUAGE plpgsql STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  label int;
BEGIN
  SELECT fy.fiscal_year INTO STRICT label FROM public.fiscal_year_for_date(p_company, p_month) fy;
  RETURN label;
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'budget month % of company % has no financial year in the registry: %', p_month, p_company, SQLERRM
    USING ERRCODE = SQLSTATE;
END;
$$;

-- Every month row without a version goes to the Original of the registry year
-- holding its month, in place. Returns the rows assigned.
CREATE OR REPLACE FUNCTION public.budget_versions_from_months(p_company uuid DEFAULT NULL)
RETURNS int
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  r record; v uuid; n int; total int := 0;
BEGIN
  FOR r IN
    SELECT DISTINCT bm.company_id, bm.month FROM budget_month_amounts bm
     WHERE bm.version_id IS NULL AND (p_company IS NULL OR bm.company_id = p_company)
     ORDER BY bm.company_id, bm.month
  LOOP
    v := public.budget_version_original(r.company_id, public.budget_month_registry_label(r.company_id, r.month),
                                        'system:migration-947');
    UPDATE budget_month_amounts SET version_id = v
     WHERE company_id = r.company_id AND month = r.month AND version_id IS NULL;
    GET DIAGNOSTICS n = ROW_COUNT;
    total := total + n;
  END LOOP;
  RETURN total;
END;
$$;

-- {company_id: {n, total, accounts: {gl_account_id: {n, total}}}} over EVERY row.
CREATE OR REPLACE FUNCTION public.budget_versions_snapshot(p_company uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH acct AS (
    SELECT company_id, gl_account_id, COUNT(*) AS n, SUM(amount) AS total
      FROM budget_month_amounts WHERE p_company IS NULL OR company_id = p_company
     GROUP BY 1, 2
  )
  SELECT COALESCE(jsonb_object_agg(company_id, jsonb_build_object('n', n, 'total', total, 'accounts', accounts)), '{}'::jsonb)
    FROM (SELECT company_id, SUM(n) AS n, SUM(total) AS total,
                 jsonb_object_agg(gl_account_id, jsonb_build_object('n', n, 'total', total)) AS accounts
            FROM acct GROUP BY company_id) c
$$;

-- Companies and company+account pairs whose count or sum, read ONLY through the
-- primary read path (the primary version of the registry year of the month),
-- differs from p_before; plus rows still without a version.
CREATE OR REPLACE FUNCTION public.budget_versions_parity_mismatches(p_before jsonb, p_company uuid DEFAULT NULL)
RETURNS int
LANGUAGE sql STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
  -- One registry lookup per distinct company and month, not per row.
  WITH labels AS MATERIALIZED (
    SELECT m.company_id, m.month, public.budget_month_registry_label(m.company_id, m.month) AS label
      FROM (SELECT DISTINCT company_id, month FROM budget_month_amounts
             WHERE p_company IS NULL OR company_id = p_company) m
  ), prim AS (
    SELECT bm.company_id, bm.gl_account_id, bm.amount
      FROM budget_month_amounts bm
      JOIN labels l ON l.company_id = bm.company_id AND l.month = bm.month
      JOIN budget_versions v ON v.id = bm.version_id AND v.company_id = bm.company_id AND v.is_primary
     WHERE (p_company IS NULL OR bm.company_id = p_company)
       AND v.fiscal_year = l.label
  ), after_acct AS (
    SELECT company_id::text AS c, gl_account_id::text AS a, COUNT(*)::numeric AS n, SUM(amount) AS total
      FROM prim GROUP BY 1, 2
  ), after_co AS (
    SELECT c, SUM(n) AS n, SUM(total) AS total FROM after_acct GROUP BY c
  ), before_co AS (
    SELECT b.key AS c, (b.value->>'n')::numeric AS n, (b.value->>'total')::numeric AS total
      FROM jsonb_each(COALESCE(p_before, '{}'::jsonb)) b
     WHERE p_company IS NULL OR b.key = p_company::text
  ), before_acct AS (
    SELECT b.key AS c, a.key AS a, (a.value->>'n')::numeric AS n, (a.value->>'total')::numeric AS total
      FROM jsonb_each(COALESCE(p_before, '{}'::jsonb)) b
      CROSS JOIN LATERAL jsonb_each(b.value->'accounts') a
     WHERE p_company IS NULL OR b.key = p_company::text
  )
  SELECT (
    (SELECT COUNT(*) FROM before_co FULL JOIN after_co USING (c)
      WHERE (before_co.n, before_co.total) IS DISTINCT FROM (after_co.n, after_co.total))
  + (SELECT COUNT(*) FROM before_acct FULL JOIN after_acct USING (c, a)
      WHERE (before_acct.n, before_acct.total) IS DISTINCT FROM (after_acct.n, after_acct.total))
  + (SELECT COUNT(*) FROM budget_month_amounts
      WHERE version_id IS NULL AND (p_company IS NULL OR company_id = p_company))
  )::int
$$;

REVOKE ALL ON FUNCTION public.budget_versions_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.budget_versions_audit() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.budget_month_amounts_dimension_kinds() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.budget_month_amounts_refuse_locked() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cost_centres_keep_budget_kind() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.budget_version_original(uuid, int, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.budget_month_registry_label(uuid, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.budget_versions_from_months(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.budget_versions_snapshot(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.budget_versions_parity_mismatches(jsonb, uuid) FROM PUBLIC;

DO $$
DECLARE
  before jsonb; converted int; bad int;
BEGIN
  -- Only rows without a version are converted; on a rerun there are none, and the snapshot (every
  -- row) would no longer equal the primary read path once non-primary versions hold amounts.
  IF NOT EXISTS (SELECT 1 FROM budget_month_amounts WHERE version_id IS NULL) THEN
    RAISE NOTICE '947: no budget months without a version; nothing to convert';
    RETURN;
  END IF;
  before := public.budget_versions_snapshot(NULL);
  converted := public.budget_versions_from_months(NULL);
  RAISE NOTICE '947: % budget months assigned to versions', converted;
  bad := public.budget_versions_parity_mismatches(before, NULL);
  IF bad > 0 THEN
    RAISE EXCEPTION '947 verification failed: % company or account budget totals/counts differ after conversion', bad;
  END IF;
  RAISE NOTICE '947: % Original versions created',
    (SELECT COUNT(*) FROM budget_versions WHERE created_by = 'system:migration-947');
END;
$$;

-- ── Keys, after the conversion ───────────────────────────────────────────────

ALTER TABLE budget_month_amounts ALTER COLUMN version_id SET NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'budget_month_amounts_one_per_cell'
                    AND conrelid = 'public.budget_month_amounts'::regclass) THEN
    ALTER TABLE budget_month_amounts ADD CONSTRAINT budget_month_amounts_one_per_cell
      UNIQUE NULLS NOT DISTINCT (company_id, version_id, gl_account_id, cc1_id, cc2_id, bu_id, month);
  END IF;
  -- Decision 4: within a version an account has ONE grain. A GiST exclusion checks
  -- committed and in-flight rows, so two writers of different grains serialise.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'budget_month_amounts_one_grain'
                    AND conrelid = 'public.budget_month_amounts'::regclass) THEN
    ALTER TABLE budget_month_amounts ADD CONSTRAINT budget_month_amounts_one_grain
      EXCLUDE USING gist (version_id WITH =, gl_account_id WITH =, dim_grain WITH <>);
  END IF;
END;
$$;
ALTER TABLE budget_month_amounts DROP CONSTRAINT IF EXISTS budget_month_amounts_one_per_month;
CREATE INDEX IF NOT EXISTS idx_bma_version_month ON budget_month_amounts (version_id, month);

-- ── 944's legacy converter, on the new key ───────────────────────────────────
-- Unchanged except the INSERT: each month goes to the primary of the registry
-- year holding it (an approved 'Original' when the year has none), keyed by
-- the new unique constraint.
CREATE OR REPLACE FUNCTION public.budget_months_from_legacy(p_company uuid DEFAULT NULL)
RETURNS int
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  b record; k text; idx int; raw text; val numeric; month_date date;
  keys text[] := ARRAY['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  monthly numeric; inserted int; converted int := 0;
BEGIN
  FOR b IN
    SELECT id, company_id, gl_account_id, fiscal_year, COALESCE(period_amounts, '{}'::jsonb) AS pa,
           COALESCE(annual_amount, 0) AS annual, created_by
      FROM accounting_budgets ab
     WHERE gl_account_id IS NOT NULL AND company_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM gl_accounts ga WHERE ga.id = ab.gl_account_id AND ga.company_id = ab.company_id)
       AND (p_company IS NULL OR company_id = p_company)
     ORDER BY company_id, gl_account_id, fiscal_year
  LOOP
    IF jsonb_typeof(b.pa) <> 'object' THEN
      RAISE EXCEPTION 'budget_months_from_legacy: budget % has period_amounts that is not an object (%)', b.id, jsonb_typeof(b.pa);
    END IF;
    FOR idx IN 1..12 LOOP
      k := keys[idx];
      IF (SELECT COUNT(*) FROM jsonb_object_keys(b.pa)) > 0 THEN
        raw := COALESCE(b.pa ->> k, b.pa ->> (idx - 1)::text);
        CONTINUE WHEN raw IS NULL;
        IF btrim(raw) = '' THEN raw := '0'; END IF;
        IF raw !~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' THEN
          RAISE EXCEPTION 'budget_months_from_legacy: budget % month % is not a number (%)', b.id, k, raw;
        END IF;
        val := round(raw::numeric, 2);
      ELSE
        CONTINUE WHEN b.annual = 0;
        monthly := round(b.annual / 12, 2);
        val := CASE WHEN idx = 12 THEN b.annual - monthly * 11 ELSE monthly END;
      END IF;
      month_date := public.budget_legacy_month(b.company_id, b.fiscal_year, idx);
      CONTINUE WHEN month_date IS NULL;  -- a key no reader ever read (see budget_legacy_month)
      INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, month, amount, created_by)
      VALUES (b.company_id,
              public.budget_version_original(b.company_id, public.budget_month_registry_label(b.company_id, month_date),
                                             COALESCE(b.created_by, 'system:migration-944')),
              b.gl_account_id, month_date, val, b.created_by)
      ON CONFLICT ON CONSTRAINT budget_month_amounts_one_per_cell DO NOTHING;
      GET DIAGNOSTICS inserted = ROW_COUNT;
      IF inserted = 0 THEN
        RAISE EXCEPTION 'budget_months_from_legacy: budget % (FY%) and another budget both claim % for account %',
          b.id, b.fiscal_year, month_date, b.gl_account_id;
      END IF;
      converted := converted + 1;
      month_date := NULL;
    END LOOP;
  END LOOP;
  RETURN converted;
END;
$$;

-- ── NL query surface ─────────────────────────────────────────────────────────
-- A free SUM(amount) over budget_month_amounts would add drafts, reforecasts
-- and scenarios together. The NL allowlist names this view instead: primary
-- versions only, each row inside its version's registry year (the readers'
-- rule). security_invoker: RLS of both tables applies to the caller.
CREATE OR REPLACE VIEW budget_primary_month_amounts WITH (security_invoker = true) AS
  SELECT bm.id, bm.company_id, bm.version_id, bm.gl_account_id, bm.cc1_id, bm.cc2_id, bm.bu_id, bm.dim_grain,
         bm.month, bm.amount, bm.created_by, bm.created_at, bm.updated_at
    FROM budget_month_amounts bm
    JOIN budget_versions v ON v.id = bm.version_id AND v.company_id = bm.company_id
   WHERE v.is_primary
     AND v.fiscal_year = (SELECT fy.fiscal_year FROM public.fiscal_year_for_date(bm.company_id, bm.month) fy);
GRANT SELECT ON budget_primary_month_amounts TO app_user;

COMMENT ON TABLE budget_versions IS
  'Budget versions (migration 947): original | reforecast | scenario; draft -> approved -> locked. Readers use the primary of each registry year unless a version is named.';
COMMENT ON COLUMN budget_month_amounts.dim_grain IS
  'Dimension kinds the amount uses: 1 CC1 + 2 CC2 + 4 BU (0 = company level). One grain per account per version (budget_month_amounts_one_grain).';
