-- 986: Comments and @mentions on invoices, bills and bank lines (master plan wave 5, M14).
--
-- WHAT.
--   record_comments  one plain-text comment on a customer invoice, a supplier invoice (bill) or a bank
--     line. Soft delete (deleted_at); an edit stamps edited_at. mentions are the user ids the author
--     named; each is notified in-app through user_notifications.
--   user_notifications.kind gains 'comment_mention' (954 allowed budget_alert, budget_slice, budget_reminder).
--
-- WHO MAY COMMENT / NOTIFY. Writing is owner, admin or manager (withWriteAccess); every one of them
-- may also notify (954's user_notifications_check lets exactly those roles send). So 954's trigger and
-- its recipient function are NOT changed, and there is no new definer and no app_definer_reviews row (930).
--
-- RULES IN THE DATABASE.
--   - Tenancy: 944's forced-RLS policy verbatim.
--   - Column privileges: id, author_id, created_at and edited_at take their defaults or the trigger's
--     values (a writable stamp gets forged). An app session can edit only body, mentions and deleted_at.
--   - Author only: an UPDATE by a session whose user is not the author is refused (42501); a deleted
--     comment cannot be edited or restored (23514). No DELETE privilege: removal is the soft delete.
--   - The service pool reaches the table through the mirror policies app_service_sync_policies() (915).
--
-- Every function here is SECURITY INVOKER: no app_definer_reviews row (930).

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS record_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  record_type TEXT NOT NULL CHECK (record_type IN ('customer_invoice', 'supplier_invoice', 'bank_transaction')),
  record_id UUID NOT NULL,
  body TEXT NOT NULL CHECK (btrim(body) <> '' AND length(body) <= 4000),
  -- users.id is TEXT (character varying): never a UUID cast.
  author_id VARCHAR(255) NOT NULL DEFAULT auth.uid() CHECK (btrim(author_id) <> ''),
  mentions TEXT[] NOT NULL DEFAULT '{}' CHECK (array_ndims(mentions) IS NULL OR (array_ndims(mentions) = 1
    AND cardinality(mentions) <= 20 AND array_position(mentions, NULL) IS NULL)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  edited_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_record_comments_record
  ON record_comments (company_id, record_type, record_id, created_at);

-- Stamps are the clock's and the session's. On INSERT: created_at is now, edited/deleted are empty.
-- On UPDATE: only the author edits (a session user; the service pool with no user is the server's
-- own code); a deleted comment is final; an edit stamps edited_at; a delete stamps deleted_at.
CREATE OR REPLACE FUNCTION public.record_comments_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := clock_timestamp();
    NEW.edited_at := NULL;
    NEW.deleted_at := NULL;
    RETURN NEW;
  END IF;
  IF auth.uid() IS NOT NULL AND OLD.author_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'only the author may change comment %', OLD.id USING ERRCODE = '42501';
  END IF;
  IF OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'comment % is deleted and cannot change', OLD.id USING ERRCODE = '23514';
  END IF;
  NEW.created_at := OLD.created_at;
  NEW.author_id := OLD.author_id;
  NEW.company_id := OLD.company_id;
  NEW.record_type := OLD.record_type;
  NEW.record_id := OLD.record_id;
  NEW.edited_at := CASE WHEN NEW.body IS DISTINCT FROM OLD.body THEN clock_timestamp() ELSE OLD.edited_at END;
  NEW.deleted_at := CASE WHEN NEW.deleted_at IS NOT NULL THEN clock_timestamp() ELSE NULL END;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_record_comments_guard ON record_comments;
CREATE TRIGGER trg_record_comments_guard BEFORE INSERT OR UPDATE ON record_comments
  FOR EACH ROW EXECUTE FUNCTION public.record_comments_guard();
ALTER TABLE record_comments ENABLE ALWAYS TRIGGER trg_record_comments_guard;
REVOKE ALL ON FUNCTION public.record_comments_guard() FROM PUBLIC;

-- ── Tenancy: 944's policy, verbatim ─────────────────────────────────────────

ALTER TABLE record_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE record_comments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON record_comments;
CREATE POLICY tenant_isolation ON record_comments FOR ALL TO app_user
  USING (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()));
-- 348's default privileges gave app_user every command: take back all but SELECT, then grant per column.
REVOKE INSERT, UPDATE, DELETE ON record_comments FROM app_user;
GRANT SELECT ON record_comments TO app_user;
GRANT INSERT (company_id, record_type, record_id, body, mentions) ON record_comments TO app_user;
GRANT UPDATE (body, mentions, deleted_at) ON record_comments TO app_user;

-- ── The in-app notification kind ────────────────────────────────────────────
-- 954's CHECK is unnamed in the file (Postgres named it user_notifications_kind_check); drop whichever
-- CHECK constrains kind, then add the widened one under a fixed name. A re-run drops and re-adds it.

DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT con.conname FROM pg_constraint con
     WHERE con.conrelid = 'public.user_notifications'::regclass AND con.contype = 'c'
       AND pg_get_constraintdef(con.oid) LIKE '%budget_reminder%'
  LOOP
    EXECUTE format('ALTER TABLE public.user_notifications DROP CONSTRAINT %I', c.conname);
  END LOOP;
END;
$$;
ALTER TABLE user_notifications DROP CONSTRAINT IF EXISTS user_notifications_kind_check;
ALTER TABLE user_notifications ADD CONSTRAINT user_notifications_kind_check
  CHECK (kind IN ('budget_alert', 'budget_slice', 'budget_reminder', 'comment_mention'));

SELECT public.app_service_sync_policies();
