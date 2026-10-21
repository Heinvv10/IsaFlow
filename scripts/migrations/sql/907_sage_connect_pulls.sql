-- 907_sage_connect_pulls.sql
--
-- "Connect to Sage": a client signs in with their Sage Accounting login, picks
-- a Sage company, reviews what will come across, then clicks Import.
--
-- Reading a Sage company takes minutes (Sage allows ~100 calls a minute and a
-- pull makes one per contact with a balance), far past the 100 s a request may
-- run behind Cloudflare. So the review request inserts a row 'pulling' and
-- answers at once; a background job in the app process reads Sage and moves
-- the row to 'ready' (pull + summary) or 'failed' (a user-safe message). The
-- Sage login is held in that job's memory only: nothing in this table can sign
-- in to Sage. The page polls the row.
--
--   status        pulling -> ready | failed; ready -> imported | discarded | expired;
--                 pulling | failed -> discarded
--   pull          the raw data read from Sage (contact names, emails, ...): present
--                 exactly while 'ready'. Cleared on import, discard, and once a
--                 review is 24 h old ('expired', POPIA: no review keeps it longer).
--   summary       counts and totals only, no contact details; kept for the audit trail
--   error         the user-safe reason of a 'failed' row
--   progress      the pull step under way, shown while 'pulling'
--   heartbeat_at  touched by the job as it goes; a 'pulling' row with no heartbeat for
--                 15 minutes (the process restarted mid-read) is reported failed, and the
--                 next review request for the company marks it so
--   ready_at      when the pull became 'ready': the 24 h clock
--
-- One read at a time per company (uq_sage_connect_pulls_one_pulling), and one
-- imported take-on per company (uq_sage_connect_pulls_one_imported): the import
-- service refuses a second take-on too, under the migration import lock; the
-- index is the backstop.
--
-- created_by has no FK: users.id is VARCHAR (GoTrue), this column is UUID, as on
-- bank_statement_imports and the other created_by columns.
--
-- RLS: the active-company form of 897 (the active company AND membership, on read and
-- write). Writers: the routes under pages/api/accounting/sage-connect (withAuth, app_user)
-- and the pull job / purge, which run as the pool role (BYPASSRLS) and name company_id in
-- every statement (src/lib/afterCommit's obligation).

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS public.sage_connect_pulls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  created_by UUID NOT NULL,
  sage_company_id INTEGER NOT NULL,
  sage_company_name TEXT,
  as_at_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'pulling',
  pull JSONB,
  summary JSONB NOT NULL DEFAULT '{}'::JSONB,
  error TEXT,
  progress TEXT,
  heartbeat_at TIMESTAMPTZ,
  migration_session_id UUID REFERENCES public.migration_sessions(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ready_at TIMESTAMPTZ,
  imported_at TIMESTAMPTZ,
  CONSTRAINT sage_connect_pulls_status_check
    CHECK (status IN ('pulling', 'ready', 'failed', 'imported', 'discarded', 'expired')),
  CONSTRAINT sage_connect_pulls_pull_present CHECK ((status = 'ready') = (pull IS NOT NULL)),
  CONSTRAINT sage_connect_pulls_ready_at CHECK (status <> 'ready' OR ready_at IS NOT NULL),
  CONSTRAINT sage_connect_pulls_failed_error CHECK (status <> 'failed' OR error IS NOT NULL),
  CONSTRAINT sage_connect_pulls_imported_session CHECK (status <> 'imported' OR migration_session_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_sage_connect_pulls_company
  ON public.sage_connect_pulls (company_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sage_connect_pulls_one_pulling
  ON public.sage_connect_pulls (company_id) WHERE status = 'pulling';
CREATE UNIQUE INDEX IF NOT EXISTS uq_sage_connect_pulls_one_imported
  ON public.sage_connect_pulls (company_id) WHERE status = 'imported';
-- The cross-tenant purge reads ready rows by age.
CREATE INDEX IF NOT EXISTS idx_sage_connect_pulls_ready
  ON public.sage_connect_pulls (ready_at) WHERE status = 'ready';

ALTER TABLE public.sage_connect_pulls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sage_connect_pulls FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON public.sage_connect_pulls;
CREATE POLICY tenant_isolation ON public.sage_connect_pulls
  FOR ALL TO app_user
  USING (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()));

-- Default privileges hand app_user and platform_admin ALL on a new table. The
-- admin portal has no use for a tenant's Sage review, so it gets nothing; rows
-- are inserted at review and updated as they move, and the app never deletes
-- one, so app_user gets exactly SELECT, INSERT, UPDATE.
REVOKE ALL ON public.sage_connect_pulls FROM PUBLIC;
REVOKE ALL ON public.sage_connect_pulls FROM app_user;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'platform_admin') THEN
    REVOKE ALL ON public.sage_connect_pulls FROM platform_admin;
  END IF;
END $$;
GRANT SELECT, INSERT, UPDATE ON public.sage_connect_pulls TO app_user;

-- Exactly one policy, in this form: a second permissive policy would be OR'd over it.
DO $$
DECLARE
  v_ok pg_catalog.bool;
BEGIN
  SELECT c.relrowsecurity AND c.relforcerowsecurity
     AND (SELECT pg_catalog.count(*) FROM pg_catalog.pg_policies p
           WHERE p.schemaname = 'public' AND p.tablename = 'sage_connect_pulls') = 1
     AND EXISTS (SELECT 1 FROM pg_catalog.pg_policies p
                  WHERE p.schemaname = 'public' AND p.tablename = 'sage_connect_pulls'
                    AND p.policyname = 'tenant_isolation' AND p.cmd = 'ALL'
                    AND p.roles = ARRAY['app_user']::pg_catalog.name[]
                    AND p.qual LIKE '%app.current_company_id()%' AND p.qual LIKE '%auth.user_companies()%'
                    AND p.with_check LIKE '%app.current_company_id()%' AND p.with_check LIKE '%auth.user_companies()%')
    INTO v_ok
    FROM pg_catalog.pg_class c
   WHERE c.oid = 'public.sage_connect_pulls'::pg_catalog.regclass;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'migration 907: sage_connect_pulls is not under FORCE RLS with exactly the active-company tenant_isolation policy';
  END IF;
END $$;
