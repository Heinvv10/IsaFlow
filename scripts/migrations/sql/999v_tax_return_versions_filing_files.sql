-- 999v: the filing file of a return version (master plan wave 6 EFa; EFb uses the EMP501 form and kind).
--
-- WHAT.
--   1. tax_return_versions.form_type also allows 'EMP501' (a superset: dropped and re-added NOT VALID, then VALIDATE).
--   2. The filing file IsaFlow generated for a version, stored, and its stamps: filing_file_content (the file's exact
--      text, so a re-download serves the stored file and never regenerates it: a later change to the generator cannot
--      make a stamped version unservable), filing_file_sha256, filing_file_kind, filing_file_at, filing_file_by (TEXT:
--      users.id is character varying). All five are set or none (CHECK); the hash is the sha256 of the content's UTF-8
--      bytes, so the stamp always names the stored file; the kind is `<file>@<generator version>` and belongs to the
--      row's form (VAT201 vat201_capture_csv, EMP201 emp201_capture_csv, EMP501 emp501_easyfile); the content is at
--      most 1 MB.
--   3. app_user may UPDATE those five columns (column grants only; 969's sweep still holds for every other role).
--   4. tax_return_versions_immutable() is replaced (still SECURITY INVOKER, so no app_definer_reviews row): 971's body,
--      unchanged, plus
--        - the filing file and its stamps are written once, only while the version is 'finalised', by the session user (the sub
--          of request.jwt.claims that withAuth sets), with filing_file_at within five minutes of the clock;
--        - the move finalised -> filed needs filing_file_sha256, but only for a version finalised at or after this
--          migration ran (tax_return_versions_filing_file_cutoff()). finalised_at is the row's creation time: it defaults
--          to now(), app_user may neither insert nor update it, and this trigger refuses any change to it.
--      As in 971 this guards against application bugs and the old colour of a deploy, not against a SQL-capable
--      app_user, who can set its own claims; only the REVOKEs hold there.
--
-- OLD COLOUR. The previous release never writes EMP501, the file or the stamps. Its mark-filed of a version finalised
-- before this migration is unaffected; of a version finalised after it, the trigger refuses with 23514, which the old
-- route does not map, so it answers 500 (not 409), with the trigger's message in the log. That is the intended effect:
-- a return finalised from now on is filed from the file IsaFlow generated.
--
-- Rollback: CREATE OR REPLACE tax_return_versions_immutable() with 971's body; REVOKE UPDATE (filing_file_content,
-- filing_file_sha256, filing_file_kind, filing_file_at, filing_file_by) ON tax_return_versions FROM app_user; DROP FUNCTION
-- public.tax_return_versions_filing_file_cutoff(). The columns and the wider CHECK can stay (nothing old reads them).

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE tax_return_versions DROP CONSTRAINT IF EXISTS tax_return_versions_form_type_check;
ALTER TABLE tax_return_versions ADD CONSTRAINT tax_return_versions_form_type_check
  CHECK (form_type IN ('VAT201', 'EMP201', 'EMP501')) NOT VALID;
ALTER TABLE tax_return_versions VALIDATE CONSTRAINT tax_return_versions_form_type_check;

ALTER TABLE tax_return_versions ADD COLUMN IF NOT EXISTS filing_file_content TEXT;
ALTER TABLE tax_return_versions ADD COLUMN IF NOT EXISTS filing_file_sha256 TEXT;
ALTER TABLE tax_return_versions ADD COLUMN IF NOT EXISTS filing_file_kind TEXT;
ALTER TABLE tax_return_versions ADD COLUMN IF NOT EXISTS filing_file_at TIMESTAMPTZ;
ALTER TABLE tax_return_versions ADD COLUMN IF NOT EXISTS filing_file_by TEXT;

ALTER TABLE tax_return_versions DROP CONSTRAINT IF EXISTS tax_return_versions_filing_file_ck;
ALTER TABLE tax_return_versions ADD CONSTRAINT tax_return_versions_filing_file_ck CHECK (
  (filing_file_content IS NULL AND filing_file_sha256 IS NULL AND filing_file_kind IS NULL AND filing_file_at IS NULL
   AND filing_file_by IS NULL)
  -- Each IS NOT NULL is spelled out: a NULL inside `~`, `=` or `IN` makes the CHECK NULL, and a NULL CHECK passes.
  OR (filing_file_content IS NOT NULL AND filing_file_sha256 IS NOT NULL AND filing_file_kind IS NOT NULL
      AND filing_file_at IS NOT NULL AND filing_file_by IS NOT NULL
      AND pg_catalog.octet_length(filing_file_content) <= 1048576
      AND filing_file_sha256 = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(filing_file_content, 'UTF8')), 'hex')
      AND ((form_type = 'VAT201' AND filing_file_kind ~ '^vat201_capture_csv@[1-9][0-9]{0,3}$')
        OR (form_type = 'EMP201' AND filing_file_kind ~ '^emp201_capture_csv@[1-9][0-9]{0,3}$')
        OR (form_type = 'EMP501' AND filing_file_kind ~ '^emp501_easyfile@[1-9][0-9]{0,3}$')))
) NOT VALID;
ALTER TABLE tax_return_versions VALIDATE CONSTRAINT tax_return_versions_filing_file_ck;

-- The cut-off: the time this migration first ran, fixed once (a re-run keeps the first value).
DO $$
BEGIN
  IF pg_catalog.to_regprocedure('public.tax_return_versions_filing_file_cutoff()') IS NULL THEN
    EXECUTE pg_catalog.format(
      'CREATE FUNCTION public.tax_return_versions_filing_file_cutoff() RETURNS pg_catalog.timestamptz '
      'LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog AS %L',
      pg_catalog.format('SELECT %L::pg_catalog.timestamptz', pg_catalog.now()));
  END IF;
END $$;
GRANT EXECUTE ON FUNCTION public.tax_return_versions_filing_file_cutoff() TO app_user, app_service, platform_admin;

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
  -- Anything but whitespace and zero-width or invisible characters. The service (returnGuards.visibleText) refuses
  -- invisible-only text with the same set, and a NUL, before the database is reached; keep the two in step.
  v_visible CONSTANT pg_catalog.text := '[^[:space:]\u00AD\u0085\u00A0\u034F\u061C\u115F-\u1160\u1680\u17B4-\u17B5\u180B-\u180F\u2000-\u200F\u2028-\u202F\u205F-\u206F\u2800\u3000\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB\U000E0000-\U000E0FFF\U00013430-\U0001343F\U0001BCA0-\U0001BCA3\U0001D173-\U0001D17A]';
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
  -- The amend stamps change only with the move to superseded (the mirror of the filing stamps above).
  IF NEW.status <> 'superseded'
     AND (NEW.amended_by, NEW.amend_reason, NEW.amended_at) IS DISTINCT FROM (OLD.amended_by, OLD.amend_reason, OLD.amended_at) THEN
    RAISE EXCEPTION 'the amend stamps change only with the move to superseded' USING ERRCODE = '23514';
  END IF;
  v_user := nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::pg_catalog.jsonb ->> 'sub';
  -- 999v: the filing file and its stamps. Written once, while the version is finalised, by the session user, now.
  IF (NEW.filing_file_content, NEW.filing_file_sha256, NEW.filing_file_kind, NEW.filing_file_at, NEW.filing_file_by)
     IS DISTINCT FROM
     (OLD.filing_file_content, OLD.filing_file_sha256, OLD.filing_file_kind, OLD.filing_file_at, OLD.filing_file_by) THEN
    IF OLD.filing_file_content IS NOT NULL OR OLD.filing_file_sha256 IS NOT NULL OR OLD.filing_file_kind IS NOT NULL
       OR OLD.filing_file_at IS NOT NULL OR OLD.filing_file_by IS NOT NULL THEN
      RAISE EXCEPTION 'the filing-file stamps of a return are written once and never changed' USING ERRCODE = '23514';
    END IF;
    IF OLD.status <> 'finalised' THEN
      RAISE EXCEPTION 'the filing-file stamps are written only while a return is finalised' USING ERRCODE = '23514';
    END IF;
    IF v_user IS NULL OR NEW.filing_file_by IS DISTINCT FROM v_user
       OR NEW.filing_file_at IS NULL OR abs(extract(epoch FROM (pg_catalog.clock_timestamp() - NEW.filing_file_at))) > 300 THEN
      RAISE EXCEPTION 'filing_file_by is the session user and filing_file_at the current time' USING ERRCODE = '23514';
    END IF;
  END IF;
  -- 999v: a version finalised from this migration on is filed only from the file IsaFlow generated for it.
  IF OLD.status = 'finalised' AND NEW.status = 'filed' AND NEW.filing_file_sha256 IS NULL
     AND OLD.finalised_at >= public.tax_return_versions_filing_file_cutoff() THEN
    RAISE EXCEPTION 'generate the filing file of this return before marking it filed' USING ERRCODE = '23514';
  END IF;
  -- Who and when are the session's, never the caller's say-so (an application-bug guard, see 971's header).
  IF (NEW.status = 'filed' AND OLD.status = 'finalised') OR (NEW.status = 'superseded') THEN
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

GRANT UPDATE (filing_file_content, filing_file_sha256, filing_file_kind, filing_file_at, filing_file_by)
  ON tax_return_versions TO app_user;

-- Postcondition (971's, widened by the five columns): app_user's column UPDATE is exactly the thirteen, nobody else's.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) x
    WHERE a.attrelid = 'public.tax_return_versions'::pg_catalog.regclass AND a.attacl IS NOT NULL AND NOT a.attisdropped
      AND x.privilege_type = 'UPDATE'
      AND NOT (x.grantee = pg_catalog.to_regrole('app_user')::pg_catalog.oid
               AND a.attname IN ('status', 'sars_submission_id', 'filed_reference', 'filed_by', 'filed_at',
                                 'amended_by', 'amend_reason', 'amended_at',
                                 'filing_file_content', 'filing_file_sha256', 'filing_file_kind', 'filing_file_at',
                                 'filing_file_by'))
      AND x.grantee <> (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = a.attrelid)
      AND x.grantee IS DISTINCT FROM pg_catalog.to_regrole('migration_admin')::pg_catalog.oid
  ) THEN
    RAISE EXCEPTION 'migration 999v: tax_return_versions has a column-level UPDATE grant beyond app_user''s thirteen columns';
  END IF;
END $$;
