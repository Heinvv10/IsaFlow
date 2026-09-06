-- scripts/migrations/sql/611_report_commentary.sql
-- WS3: AI commentary as a draft until a named user approves it, plus internal
-- row annotations.
--
-- draft_text and approved_text are SEPARATE COLUMNS on purpose. A single `text`
-- column plus a status flag makes "publish only approved text" a filter that
-- every future reader must remember to apply; two columns make it structural —
-- the share loader selects approved_text and there is no draft in the result to
-- forget to exclude.
--
-- row_ref is NOT NULL DEFAULT '' rather than nullable so the uniqueness key is
-- a plain unique index. A nullable column in a unique index does not collide
-- with itself in Postgres, and the expression-index workaround then forces
-- every ON CONFLICT to reproduce the expression exactly — a trap this schema
-- does not need to walk into for one optional field.
--
-- params_hash is sha256(type|from|to) computed by
-- src/modules/accounting/services/share/shareParams.ts. Storing the hash rather
-- than the three fields keeps the uniqueness key one column and lets a future
-- report kind with different parameters reuse the table unchanged.

CREATE TABLE IF NOT EXISTS report_commentary (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES companies(id),
  report_kind   TEXT NOT NULL,
  params_hash   TEXT NOT NULL,
  period_start  DATE NOT NULL,
  period_end    DATE NOT NULL,
  section_ref   TEXT NOT NULL,
  row_ref       TEXT NOT NULL DEFAULT '',
  draft_text    TEXT NOT NULL,
  approved_text TEXT,
  status        TEXT NOT NULL DEFAULT 'draft',
  generated_by  TEXT NOT NULL,
  approved_by   TEXT,
  approved_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT report_commentary_status_chk CHECK (status IN ('draft', 'approved', 'rejected')),
  -- An approved row must carry both the text and the approver. This is the
  -- invariant the share loader depends on; enforce it in the schema, not only
  -- in the service.
  CONSTRAINT report_commentary_approved_chk CHECK (
    status <> 'approved'
    OR (approved_text IS NOT NULL AND approved_by IS NOT NULL AND approved_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_report_commentary_ref
  ON report_commentary (company_id, report_kind, params_hash, section_ref, row_ref);

CREATE INDEX IF NOT EXISTS idx_report_commentary_published
  ON report_commentary (company_id, params_hash, status);

CREATE TABLE IF NOT EXISTS report_annotations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES companies(id),
  row_id        TEXT NOT NULL,
  period_start  DATE NOT NULL,
  period_end    DATE NOT NULL,
  body          TEXT NOT NULL,
  author        TEXT NOT NULL,
  author_name   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at   TIMESTAMPTZ,
  resolved_by   TEXT
);

CREATE INDEX IF NOT EXISTS idx_report_annotations_row
  ON report_annotations (company_id, row_id, period_start, period_end);

ALTER TABLE report_commentary ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_commentary FORCE ROW LEVEL SECURITY;
ALTER TABLE report_annotations ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_annotations FORCE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['report_commentary', 'report_annotations'] LOOP
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
