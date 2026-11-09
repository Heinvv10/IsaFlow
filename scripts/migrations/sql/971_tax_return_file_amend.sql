-- 971: file and amend a return (master plan wave 5, L1b).
--
-- WHAT.
--   1. tax_return_versions: app_user may now UPDATE the columns a filing and an amend write (status,
--      sars_submission_id, filed_*, amended_*), and the immutability trigger gains a status-transition guard and
--      judges who and when (see RULES).
--   2. The same-company trigger also fires ON UPDATE OF sars_submission_id, amends_version_id, vat_period_lock_id.
--   3. A BEFORE UPDATE trigger on sars_submissions refuses to change status, submission_reference or submitted_at of
--      a submission a return version names: the legacy mark-submitted route cannot re-file a filed return.
--   4. A BEFORE UPDATE trigger on vat_period_locks refuses to unlock a lock a live (non-superseded) version names:
--      the amend is the only way out, for every role.
--   NOT in this migration (deliberately, a follow-up after the next deploy): a unique index of one open draft per
--   company, form and period, and the dedupe of existing duplicate drafts. The old colour of a blue/green deploy
--   (and a code-only rollback) still INSERTs drafts plainly; a unique index would turn that into 23505 for as long as
--   it runs. saveDraftSubmission serialises on an advisory lock instead.
--
-- RULES IN THE DATABASE (tax_return_versions, every role, owner included).
--   - Status moves finalised to filed, finalised to superseded, or filed to superseded; never out of superseded.
--   - A superseded row is frozen: no column of it changes again.
--   - Filing stamps (sars_submission_id, filed_reference, filed_by, filed_at) are set together, only by the move
--     finalised to filed, and once only. The submission must be this company's, for this form and period, and
--     already submitted. The filing reference must hold a visible character.
--   - A move to superseded must carry the amend stamps (amended_by, amend_reason, amended_at); the reason must hold a
--     visible character.
--   - filed_by and amended_by must equal the session user (the sub of request.jwt.claims that withAuth sets), and
--     filed_at and amended_at must be within five minutes of the clock: a stamp cannot be forged, and a session with
--     no user (direct SQL) cannot file or supersede.
--   - The figures, period, chain, lock and finalised_* stay unchangeable, as 969 made them.
--
-- WRITES. UPDATE is granted to app_user on the eight named columns only, never at table level. 969's sweep still
-- holds for every other role; the postcondition below fails the migration if any other grantee has UPDATE, or if
-- app_user has it on any other column.
--
-- Rollback: restore the 969 versions of tax_return_versions_immutable() and tax_return_versions_same_company(),
-- recreate trg_tax_return_versions_same_company as BEFORE INSERT, REVOKE UPDATE on the eight columns from app_user,
-- DROP TRIGGER trg_sars_submissions_filed_frozen ON sars_submissions, DROP TRIGGER trg_vat_period_locks_in_return ON
-- vat_period_locks, and drop the two functions behind them.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- The same-company check, now also on UPDATE. On an UPDATE a reference is judged only when it changed, so a
-- filing (which leaves the lock and the chain alone) is not refused because its lock was released by an amend.
CREATE OR REPLACE FUNCTION public.tax_return_versions_same_company()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.amends_version_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.amends_version_id IS DISTINCT FROM OLD.amends_version_id)
     AND NOT EXISTS (
       SELECT 1 FROM tax_return_versions v
        WHERE v.id = NEW.amends_version_id AND v.company_id = NEW.company_id
          AND v.form_type = NEW.form_type AND v.period_start = NEW.period_start AND v.period_end = NEW.period_end) THEN
    RAISE EXCEPTION 'amends_version_id % is not a version of this company''s same return', NEW.amends_version_id
      USING ERRCODE = '23514';
  END IF;
  IF NEW.vat_period_lock_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.vat_period_lock_id IS DISTINCT FROM OLD.vat_period_lock_id) THEN
    -- FOR SHARE: an unlock racing this write waits for it, so the lock cannot be released between check and write.
    PERFORM 1 FROM vat_period_locks l
      WHERE l.id = NEW.vat_period_lock_id AND l.company_id = NEW.company_id
        AND l.period_start = NEW.period_start AND l.period_end = NEW.period_end AND l.unlocked_at IS NULL
      FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'vat_period_lock_id % is not this company''s active lock for this period', NEW.vat_period_lock_id
        USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.sars_submission_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.sars_submission_id IS DISTINCT FROM OLD.sars_submission_id)
     AND NOT EXISTS (
       SELECT 1 FROM sars_submissions s
        WHERE s.id = NEW.sars_submission_id AND s.company_id = NEW.company_id
          AND s.form_type = NEW.form_type AND s.period_start = NEW.period_start AND s.period_end = NEW.period_end
          AND s.status = 'submitted') THEN
    RAISE EXCEPTION 'sars_submission_id % is not this company''s submitted submission for this form and period',
      NEW.sars_submission_id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_tax_return_versions_same_company ON tax_return_versions;
CREATE TRIGGER trg_tax_return_versions_same_company
  BEFORE INSERT OR UPDATE OF sars_submission_id, amends_version_id, vat_period_lock_id ON tax_return_versions
  FOR EACH ROW EXECUTE FUNCTION public.tax_return_versions_same_company();
ALTER TABLE tax_return_versions ENABLE ALWAYS TRIGGER trg_tax_return_versions_same_company;

-- The immutability trigger with the transition guard. The first two checks are 969's, unchanged.
CREATE OR REPLACE FUNCTION public.tax_return_versions_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_user pg_catalog.text;
  v_by pg_catalog.text;
  v_at pg_catalog.timestamptz;
  -- Anything but whitespace and zero-width or invisible characters (the service strips the same set).
  v_visible CONSTANT pg_catalog.text := '[^[:space:]\u00A0\u180E\u1680\u2000-\u200F\u2028-\u202F\u205F-\u2064\u3000\uFEFF]';
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
  IF OLD.status = 'superseded' THEN
    IF pg_catalog.to_jsonb(NEW) IS DISTINCT FROM pg_catalog.to_jsonb(OLD) THEN
      RAISE EXCEPTION 'a superseded return is frozen: nothing about it changes again' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'finalised' AND NEW.status IN ('filed', 'superseded'))
       OR (OLD.status = 'filed' AND NEW.status = 'superseded')) THEN
    RAISE EXCEPTION 'a return may not move from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF (OLD.sars_submission_id, OLD.filed_reference, OLD.filed_by, OLD.filed_at)
     IS DISTINCT FROM (NULL::uuid, NULL::text, NULL::text, NULL::timestamptz) THEN
    IF (NEW.sars_submission_id, NEW.filed_reference, NEW.filed_by, NEW.filed_at)
       IS DISTINCT FROM (OLD.sars_submission_id, OLD.filed_reference, OLD.filed_by, OLD.filed_at) THEN
      RAISE EXCEPTION 'the filing stamps of a return are written once and never changed' USING ERRCODE = '23514';
    END IF;
  ELSIF (NEW.sars_submission_id, NEW.filed_reference, NEW.filed_by, NEW.filed_at)
        IS DISTINCT FROM (NULL::uuid, NULL::text, NULL::text, NULL::timestamptz) THEN
    IF NOT (OLD.status = 'finalised' AND NEW.status = 'filed') THEN
      RAISE EXCEPTION 'the filing stamps are written only by the move from finalised to filed' USING ERRCODE = '23514';
    END IF;
    IF NEW.sars_submission_id IS NULL OR NEW.filed_reference IS NULL OR pg_catalog.btrim(NEW.filed_reference) = '' THEN
      RAISE EXCEPTION 'a filed return names its submission and carries a filing reference' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.status = 'superseded' AND (NEW.amended_by IS NULL OR NEW.amend_reason IS NULL OR NEW.amended_at IS NULL) THEN
    RAISE EXCEPTION 'a return is superseded only by an amend that records who, when and why' USING ERRCODE = '23514';
  END IF;
  -- Who and when are the session's, never the caller's say-so.
  IF (NEW.status = 'filed' AND OLD.status = 'finalised') OR (NEW.status = 'superseded') THEN
    v_user := nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::pg_catalog.jsonb ->> 'sub';
    IF NEW.status = 'filed' THEN
      v_by := NEW.filed_by; v_at := NEW.filed_at;
      IF NEW.filed_reference !~ v_visible THEN
        RAISE EXCEPTION 'a filing reference must hold a visible character' USING ERRCODE = '23514';
      END IF;
    ELSE
      v_by := NEW.amended_by; v_at := NEW.amended_at;
      IF NEW.amend_reason !~ v_visible THEN
        RAISE EXCEPTION 'an amend reason must hold a visible character' USING ERRCODE = '23514';
      END IF;
    END IF;
    IF v_user IS NULL OR v_by IS DISTINCT FROM v_user
       OR abs(extract(epoch FROM (pg_catalog.clock_timestamp() - v_at))) > 300 THEN
      RAISE EXCEPTION 'filed_by and amended_by are the session user, and filed_at and amended_at the current time' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- A submission a return version names keeps its status, reference and time: the legacy mark-submitted route (and any
-- other writer) cannot re-file it. The lifecycle marks the submission submitted BEFORE a version names it.
CREATE OR REPLACE FUNCTION public.sars_submissions_filed_frozen()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF (NEW.status, NEW.submission_reference, NEW.submitted_at)
     IS DISTINCT FROM (OLD.status, OLD.submission_reference, OLD.submitted_at)
     AND EXISTS (SELECT 1 FROM tax_return_versions v WHERE v.sars_submission_id = OLD.id) THEN
    RAISE EXCEPTION 'submission % is named by a return version: file through the return lifecycle', OLD.id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_sars_submissions_filed_frozen ON sars_submissions;
CREATE TRIGGER trg_sars_submissions_filed_frozen
  BEFORE UPDATE OF status, submission_reference, submitted_at ON sars_submissions
  FOR EACH ROW EXECUTE FUNCTION public.sars_submissions_filed_frozen();
ALTER TABLE sars_submissions ENABLE ALWAYS TRIGGER trg_sars_submissions_filed_frozen;

-- A lock a live version names is released by an amend, never directly. The amend supersedes the version first, in
-- the same transaction, so its own unlock passes. SECURITY INVOKER: a BYPASSRLS role sees every version, app_user
-- sees its own company's, which is where its locks are.
CREATE OR REPLACE FUNCTION public.vat_period_locks_in_return()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF OLD.unlocked_at IS NULL AND NEW.unlocked_at IS NOT NULL AND EXISTS (
       SELECT 1 FROM tax_return_versions v WHERE v.vat_period_lock_id = OLD.id AND v.status <> 'superseded') THEN
    RAISE EXCEPTION 'vat period lock % is named by a live return version: amend the return instead', OLD.id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_vat_period_locks_in_return ON vat_period_locks;
CREATE TRIGGER trg_vat_period_locks_in_return
  BEFORE UPDATE OF unlocked_at ON vat_period_locks
  FOR EACH ROW EXECUTE FUNCTION public.vat_period_locks_in_return();
ALTER TABLE vat_period_locks ENABLE ALWAYS TRIGGER trg_vat_period_locks_in_return;

-- The columns a filing and an amend write; nothing else is ever granted.
GRANT UPDATE (status, sars_submission_id, filed_reference, filed_by, filed_at, amended_by, amend_reason, amended_at)
  ON tax_return_versions TO app_user;

-- Postcondition: UPDATE exists nowhere but on those columns for app_user, and (969's sweep) at table level for no
-- one but the owner and migration_admin.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) x
    WHERE a.attrelid = 'public.tax_return_versions'::pg_catalog.regclass AND a.attacl IS NOT NULL AND NOT a.attisdropped
      AND x.privilege_type = 'UPDATE'
      AND NOT (x.grantee = pg_catalog.to_regrole('app_user')::pg_catalog.oid
               AND a.attname IN ('status', 'sars_submission_id', 'filed_reference', 'filed_by', 'filed_at',
                                 'amended_by', 'amend_reason', 'amended_at'))
      AND x.grantee <> (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = a.attrelid)
      AND x.grantee IS DISTINCT FROM pg_catalog.to_regrole('migration_admin')::pg_catalog.oid
  ) THEN
    RAISE EXCEPTION 'migration 971: tax_return_versions has a column-level UPDATE grant beyond app_user''s eight columns';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) a
    WHERE c.oid = 'public.tax_return_versions'::pg_catalog.regclass
      AND a.privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE') AND a.grantee <> c.relowner
      AND a.grantee IS DISTINCT FROM pg_catalog.to_regrole('migration_admin')::pg_catalog.oid
  ) THEN
    RAISE EXCEPTION 'migration 971: tax_return_versions grants a table-level writer privilege beyond its owner and migration_admin';
  END IF;
END $$;
