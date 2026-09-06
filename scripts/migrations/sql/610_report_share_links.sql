-- scripts/migrations/sql/610_report_share_links.sql
-- WS3: signed, expiring, revocable share links for report packs.
--
-- The TOKEN IS NEVER STORED. `token_hash` is sha256(token) hex; the raw token
-- is returned exactly once, at creation, and is thereafter only ever presented
-- by a viewer. A database dump therefore does not hand anyone a working link.
--
-- `report_kind` + `params` rather than a foreign key to a saved pack: a pack in
-- this codebase is BUILT per request from (type, from, to) by
-- reportPackService.buildReportPack and is not persisted. Storing the inputs
-- means a link renders the same figures on every view without WS3 depending on
-- WS2's pack storage, and it keeps the link's blast radius to one report.
--
-- No FK on created_by / revoked_by: users.id is character varying(255) with a
-- gen_random_uuid()::text default, so a uuid-typed FK to it fails at apply
-- time. TEXT, unconstrained, as everywhere else in this schema (see mig 595).

CREATE TABLE IF NOT EXISTS share_links (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES companies(id),
  report_kind   TEXT NOT NULL,
  params        JSONB NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  label         TEXT,
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '30 days',
  revoked_at    TIMESTAMPTZ,
  revoked_by    TEXT,
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  view_count    INTEGER NOT NULL DEFAULT 0,
  last_viewed_at TIMESTAMPTZ,
  CONSTRAINT share_links_kind_chk CHECK (report_kind IN ('pack'))
);

CREATE INDEX IF NOT EXISTS idx_share_links_company
  ON share_links (company_id, created_at DESC);

-- Every view, including views of a dead link. `outcome` separates a successful
-- render from a hit on an expired or revoked link, which is the difference
-- between "a client read the pack" and "someone is using a link we withdrew".
CREATE TABLE IF NOT EXISTS share_link_views (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES companies(id),
  share_link_id UUID NOT NULL REFERENCES share_links(id) ON DELETE CASCADE,
  outcome       TEXT NOT NULL,
  ip_address    TEXT,
  user_agent    TEXT,
  viewed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT share_link_views_outcome_chk CHECK (outcome IN ('ok', 'expired', 'revoked'))
);

CREATE INDEX IF NOT EXISTS idx_share_link_views_link
  ON share_link_views (share_link_id, viewed_at DESC);

CREATE INDEX IF NOT EXISTS idx_share_link_views_company
  ON share_link_views (company_id, viewed_at DESC);

-- Tenant isolation. Shape copied verbatim from 596_gl_account_merges_rls.sql.
-- Note this does NOT constrain the public share route: that route runs on the
-- pool connection as a superuser, which bypasses RLS. It constrains every
-- AUTHENTICATED path, which is where a cross-tenant read of another company's
-- links would otherwise be possible.
ALTER TABLE share_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE share_links FORCE ROW LEVEL SECURITY;
ALTER TABLE share_link_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE share_link_views FORCE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['share_links', 'share_link_views'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = t AND policyname = 'tenant_isolation'
    ) THEN
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON public.%I TO app_user '
        'USING (company_id IN (SELECT auth.user_companies())) '
        'WITH CHECK (company_id = app.current_company_id())', t);
    END IF;
  END LOOP;
END $$;
