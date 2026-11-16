-- 999c: a user marks a SARS calendar item (VAT201, EMP201, EMP501, IRP6) as filed, and can undo it.
--
-- WHAT. sars_compliance_events (231, company_id since 291) was read by the SARS page's overlay but
-- written by nothing, so every past item showed overdue. A mark is one row:
--   period_end      the period the return covers. A mark keys on (company_id, event_type, period_end),
--                   not the due date: due dates move with the date rules (weekend -> Friday, #1461).
--                   NULL only on rows from before this migration (none on prod, 2026-11-15 dump).
--   sars_reference  the SARS reference the user typed, optional.
--   filed_by        the session user (auth.uid()), stamped by trigger.
--   filed_at        the clock, stamped by trigger.
-- Undo is a DELETE (the audit row keeps the history); a second mark of one period is 23505.
--
-- RULES IN THE DATABASE.
--   - Tenancy: 944's forced-RLS policy, verbatim (the old one admitted any of the user's companies
--     on USING, not only the request's company).
--   - Column privileges: app_user INSERTs only the columns a mark sends; ids and stamps take their
--     values from defaults and the trigger (a writable stamp gets forged). No UPDATE: a mark is
--     never edited, only deleted.
--   - A mark with no session user is refused: there is no one to stamp.
--   - The service pool reaches the table through 915's USING (true) mirrors (no code does today).
--
-- The trigger function is SECURITY INVOKER: no app_definer_reviews row (930).

SET LOCAL lock_timeout = '5s';

ALTER TABLE sars_compliance_events ADD COLUMN IF NOT EXISTS period_end DATE;
ALTER TABLE sars_compliance_events ADD COLUMN IF NOT EXISTS sars_reference TEXT
  CONSTRAINT sars_compliance_events_reference_shape
  CHECK (sars_reference IS NULL OR (btrim(sars_reference) <> '' AND length(sars_reference) <= 100));
ALTER TABLE sars_compliance_events ADD COLUMN IF NOT EXISTS filed_by VARCHAR(255);
ALTER TABLE sars_compliance_events ADD COLUMN IF NOT EXISTS filed_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS uq_sars_compliance_events_period
  ON sars_compliance_events (company_id, event_type, period_end) WHERE period_end IS NOT NULL;

-- ── Stamps ──────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.sars_compliance_events_stamp()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  uid text := auth.uid();
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'sars_compliance_events: a mark needs a session user'
      USING ERRCODE = '42501';
  END IF;
  NEW.filed_by := uid;
  NEW.filed_at := clock_timestamp();
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_sars_compliance_events_stamp ON sars_compliance_events;
CREATE TRIGGER trg_sars_compliance_events_stamp BEFORE INSERT ON sars_compliance_events
  FOR EACH ROW EXECUTE FUNCTION public.sars_compliance_events_stamp();
ALTER TABLE sars_compliance_events ENABLE ALWAYS TRIGGER trg_sars_compliance_events_stamp;

-- ── Tenancy: 944's policy, verbatim ─────────────────────────────────────────

ALTER TABLE sars_compliance_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE sars_compliance_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON sars_compliance_events;
CREATE POLICY tenant_isolation ON sars_compliance_events FOR ALL TO app_user
  USING (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()));

REVOKE INSERT, UPDATE, DELETE ON sars_compliance_events FROM app_user;
GRANT SELECT ON sars_compliance_events TO app_user;
GRANT INSERT (company_id, event_type, due_date, period_end, description, status, sars_reference)
  ON sars_compliance_events TO app_user;
GRANT DELETE ON sars_compliance_events TO app_user;

-- The service pool reaches the table through these mirrors.
SELECT public.app_service_sync_policies();
