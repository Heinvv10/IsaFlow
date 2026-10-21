-- 907_sage_connect_pulls.sql
--
-- "Connect to Sage": a client signs in with their Sage Accounting login, picks
-- a Sage company, reviews what will come across, then clicks Import. The review
-- and the import are separate requests, so the data read from Sage is kept
-- between them here — the Sage login is NOT: it is used for the read and
-- discarded, and nothing in this table can sign in to Sage.
--
-- The raw pull is kept (not the finished take-on) so the import rebuilds the
-- take-on against the company's chart as it stands at import time. `pull` is
-- cleared once the pull is imported or discarded; `summary` (counts and
-- totals, no contact details) is kept for the audit trail.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS public.sage_connect_pulls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id),
  created_by UUID NOT NULL,
  sage_company_id INTEGER NOT NULL,
  sage_company_name TEXT NOT NULL,
  as_at_date DATE NOT NULL,
  pull JSONB,
  summary JSONB NOT NULL DEFAULT '{}'::JSONB,
  status TEXT NOT NULL DEFAULT 'ready',
  migration_session_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  imported_at TIMESTAMPTZ,
  CONSTRAINT sage_connect_pulls_status_check CHECK (status IN ('ready', 'imported', 'discarded')),
  CONSTRAINT sage_connect_pulls_pull_present CHECK ((status = 'ready') = (pull IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_sage_connect_pulls_company
  ON public.sage_connect_pulls (company_id, created_at DESC);

ALTER TABLE public.sage_connect_pulls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sage_connect_pulls FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'sage_connect_pulls'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON public.sage_connect_pulls
      TO app_user
      USING (company_id IN (SELECT auth.user_companies()))
      WITH CHECK (company_id = app.current_company_id());
  END IF;
END $$;

-- Rows are inserted at review, updated once (imported / discarded); never deleted by the app.
GRANT SELECT, INSERT, UPDATE ON public.sage_connect_pulls TO app_user, platform_admin;
